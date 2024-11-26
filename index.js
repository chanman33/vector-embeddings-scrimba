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
 * Document Search
 * Handles similarity search functionality using vector embeddings
 */
async function searchSimilarDocuments(queryText, limit = 3) {
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

    return similarDocuments;
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
 * Creates and manages the search interface
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
      const results = await searchSimilarDocuments(query);
      resultsDiv.innerHTML = results.map(doc => `
        <div style="margin: 1em 0; padding: 1em; border: 1px solid #ccc;">
          <p>${doc.content}</p>
          <small>Similarity: ${(doc.similarity * 100).toFixed(1)}%</small>
        </div>
      `).join('');
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