import { openai, supabase } from './config.js';
import podcasts from './content.js';
import { processAndStoreMovies } from './movieProcessor.js';
import { rateLimiter, delay } from './rateLimiter.js';
import { searchMovies } from './search.js';  // Add this import


/**
 * Embedding Generation
 * Handles the creation and retry logic for OpenAI embeddings
 */
async function getEmbeddingWithRetry(textChunk, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await rateLimiter.waitForToken();
      
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: textChunk
      });
      return embeddingResponse.data[0].embedding;
    } catch (error) {
      console.error('Embedding error:', error);
      if (error.status === 429) {
        console.log(`Rate limited, waiting 25 seconds before retry ${i + 1}/${retries}`);
        await delay(25000);
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries reached for embedding generation');
}

/**
 * Chat Completion
 * Generates conversational responses using OpenAI's chat completion
 */
async function generateChatResponse(documents, query) {
  const context = documents.map(doc => doc.content).join('\n\n');
  
  const messages = [
    {
      role: 'system',
      content: `You are an enthusiastic podcast expert who helps users find relevant podcast episodes. 
                Provide concise, natural responses that directly answer the user's question using the 
                provided context. If the context doesn't contain relevant information, politely say so. 
                Include specific episode references when possible. Keep responses under 3 sentences.`
    },
    {
      role: 'user',
      content: `Context: ${context}\n\nQuestion: ${query}`
    }
  ];

  try {
    await rateLimiter.waitForToken();
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      temperature: 0.7,
      max_tokens: 150,
      presence_penalty: 0.3,
      frequency_penalty: 0.3
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Chat completion error:', error);
    throw error;
  }
}

/**
 * Document Search
 * Modified to include conversational response
 */
async function searchSimilarDocuments(queryText, limit = 1) {
  try {
    console.log('Getting embedding for query:', queryText);
    const queryEmbedding = await getEmbeddingWithRetry(queryText);

    const { data: similarDocuments, error } = await supabase
      .rpc('match_documents', {
        query_embedding: queryEmbedding,
        match_threshold: 0.5,
        match_count: limit
      });

    if (error) {
      console.error('Error performing similarity search:', error);
      throw error;
    }

    // Generate conversational response
    const chatResponse = await generateChatResponse(similarDocuments, queryText);
    
    return {
      documents: similarDocuments,
      response: chatResponse
    };
  } catch (error) {
    console.error('Search error:', error);
    throw error;
  }
}

/**
 * Database Operations
 * Handles storing and managing embeddings in the database
 */
async function storeEmbeddings(documents) {
  console.log('Starting to store embeddings...');
  for (let i = 0; i < documents.length; i++) {
    const text = documents[i];
    try {
      const embedding = await getEmbeddingWithRetry(text);
      console.log(`Generated embedding for document ${i + 1}/${documents.length}`);

      const { data, error } = await supabase
        .from('documents')
        .insert([{ content: text, embedding }])
        .select();

      if (error) {
        console.error('Error storing embedding:', error);
        continue;
      }

      console.log(`Stored document ${i + 1} with ID:`, data[0].id);
      await delay(1000);
    } catch (error) {
      console.error(`Failed to process document ${i + 1}:`, error);
    }
  }
  console.log('Finished storing embeddings');
}

/**
 * Status Bar Component
 */
function createStatusBar() {
  const statusBar = document.createElement('div');
  statusBar.className = 'status-bar';
  statusBar.innerHTML = `
    <div class="status-item">
      <span>Podcasts: </span>
      <span id="podcastStatus" class="status pending">Pending</span>
    </div>
    <div class="status-item">
      <span>Movies: </span>
      <span id="movieStatus" class="status pending">Pending</span>
    </div>
  `;
  
  // Add some basic styles
  const style = document.createElement('style');
  style.textContent = `
    .status-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: #f5f5f5;
      padding: 8px;
      display: flex;
      justify-content: center;
      gap: 20px;
      border-bottom: 1px solid #ddd;
    }
    .status {
      font-weight: bold;
      padding: 2px 8px;
      border-radius: 4px;
    }
    .status.pending {
      background: #ffd700;
      color: #000;
    }
    .status.ready {
      background: #4CAF50;
      color: white;
    }
  `;
  document.head.appendChild(style);
  return statusBar;
}

/**
 * Modified initialize function
 */
async function initialize() {
  try {
    // Update podcast status
    const podcastStatus = document.getElementById('podcastStatus');
    
    const { data: existingDocs, error: checkError } = await supabase
      .from('documents')
      .select('id')
      .limit(1);

    if (checkError) throw checkError;

    if (!existingDocs?.length) {
      console.log('No existing documents found, storing embeddings...');
      await storeEmbeddings(podcasts);
    }
    
    podcastStatus.textContent = 'Ready';
    podcastStatus.className = 'status ready';

    // Process movies automatically
    const movieStatus = document.getElementById('movieStatus');
    await processAndStoreMovies();
    movieStatus.textContent = 'Ready';
    movieStatus.className = 'status ready';
    
  } catch (error) {
    console.error('Initialization error:', error);
    // Update status to show error if needed
    const podcastStatus = document.getElementById('podcastStatus');
    const movieStatus = document.getElementById('movieStatus');
    podcastStatus.textContent = 'Error';
    movieStatus.textContent = 'Error';
    podcastStatus.style.backgroundColor = '#ff4444';
    movieStatus.style.backgroundColor = '#ff4444';
  }
}

/**
 * UI Setup
 * Modified to use the new HTML structure
 */
function setupSearchUI() {
  // Get podcast search elements
  const podcastForm = document.querySelector('#podcastSection .search-form');
  const podcastInput = document.querySelector('#podcastQuery');
  const podcastResults = document.querySelector('#podcastResults');

  // Handle podcast search
  podcastForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = podcastInput.value.trim();
    if (!query) return;

    try {
      podcastResults.innerHTML = 'Searching...';
      const { documents, response } = await searchSimilarDocuments(query);
      
      podcastResults.innerHTML = `
        <div style="margin-bottom: 2em; padding: 1em; background: #f5f5f5; border-radius: 8px;">
          <h3>AI Response:</h3>
          <p>${response}</p>
        </div>
        <h3>Related Episodes:</h3>
        ${documents.map(doc => `
          <div style="margin: 1em 0; padding: 1em; border: 1px solid #ccc; border-radius: 4px;">
            <p>${doc.content}</p>
            <small>Similarity: ${(doc.similarity * 100).toFixed(1)}%</small>
          </div>
        `).join('')}
      `;
    } catch (error) {
      podcastResults.innerHTML = `Error: ${error.message}`;
    }
  });
}

function setupMovieSearchUI() {
  // Get movie search elements
  const movieForm = document.querySelector('#movieSection .search-form');
  const movieInput = document.querySelector('#movieQuery');
  const movieResults = document.querySelector('#movieResults');

  // Handle movie search
  movieForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = movieInput.value.trim();
    if (!query) return;

    try {
      movieResults.innerHTML = 'Searching...';
      const { movies, response } = await searchMovies(query);
      
      movieResults.innerHTML = `
        <div style="margin-bottom: 2em; padding: 1em; background: #f5f5f5; border-radius: 8px;">
          <h3>AI Response:</h3>
          <p>${response}</p>
        </div>
        <h3>Related Movies:</h3>
        ${movies.map(movie => `
          <div style="margin: 1em 0; padding: 1em; border: 1px solid #ccc; border-radius: 4px;">
            <p>${movie.content}</p>
            <small>Similarity: ${(movie.similarity * 100).toFixed(1)}%</small>
          </div>
        `).join('')}
      `;
    } catch (error) {
      movieResults.innerHTML = `Error: ${error.message}`;
      console.error('Search error:', error);
    }
  });
}

// Modified DOMContentLoaded event listener
document.addEventListener('DOMContentLoaded', () => {
  console.log('Starting initialization...');
  
  // Add status bar to page
  const statusBar = createStatusBar();
  document.body.insertBefore(statusBar, document.body.firstChild);
  
  // Initialize the database and setup both search UIs
  initialize().then(() => {
    setupSearchUI();
    setupMovieSearchUI();
  });
});