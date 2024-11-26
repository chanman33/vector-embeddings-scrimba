import { openai, supabase } from './config.js';
import podcasts from './content.js';

/**
 * Utility Functions
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Rate Limiter Implementation
 * Manages API request rates to prevent hitting OpenAI's rate limits
 */
class RateLimiter {
  constructor(tokensPerMinute) {
    this.tokens = tokensPerMinute;
    this.maxTokens = tokensPerMinute;
    this.lastRefill = Date.now();
  }

  async waitForToken() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const refillAmount = Math.floor(timePassed / (60 * 1000) * this.maxTokens);
    
    this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitTime = Math.ceil((60 * 1000) / this.maxTokens);
      console.log(`Rate limit reached, waiting ${waitTime/1000} seconds...`);
      await delay(waitTime);
      return this.waitForToken();
    }

    this.tokens--;
    return true;
  }
}

// Initialize rate limiter with OpenAI's limit
const rateLimiter = new RateLimiter(3);

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
 * Database Initialization
 * Checks and initializes the database with embeddings if needed
 */
async function initialize() {
  try {
    const { data: existingDocs, error: checkError } = await supabase
      .from('documents')
      .select('id')
      .limit(1);

    if (checkError) throw checkError;

    if (!existingDocs?.length) {
      console.log('No existing documents found, storing embeddings...');
      await storeEmbeddings(podcasts);
    } else {
      console.log('Documents already exist in the database');
    }
  } catch (error) {
    console.error('Initialization error:', error);
  }
}

/**
 * UI Setup
 * Modified to display conversational response
 */
function setupSearchUI() {
  const searchForm = document.createElement('form');
  const searchInput = document.createElement('input');
  const searchButton = document.createElement('button');
  const resultsDiv = document.createElement('div');

  // Configure UI elements
  searchInput.type = 'text';
  searchInput.placeholder = 'Enter your search query...';
  searchButton.textContent = 'Search';
  resultsDiv.id = 'searchResults';

  // Assemble UI
  searchForm.appendChild(searchInput);
  searchForm.appendChild(searchButton);
  document.body.appendChild(searchForm);
  document.body.appendChild(resultsDiv);

  // Handle search submissions
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;

    try {
      resultsDiv.innerHTML = 'Searching...';
      const { documents, response } = await searchSimilarDocuments(query);
      
      resultsDiv.innerHTML = `
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
      resultsDiv.innerHTML = `Error: ${error.message}`;
    }
  });
}

// Initialize application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('Starting initialization...');
  initialize();
  setupSearchUI();
});