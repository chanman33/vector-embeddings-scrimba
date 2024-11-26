import { openai, supabase } from './config.js';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { rateLimiter, delay } from './rateLimiter.js';

/* Split movies.txt into text chunks */
async function splitMovieData(text) {
  try {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 500,
      chunkOverlap: 50,
    });
    const output = await splitter.createDocuments([text]);
    
    console.log(`Successfully split into ${output.length} chunks`);
    return output;
  } catch (error) {
    console.error('Error splitting movies:', error);
    throw error;
  }
}

/* Create embeddings and store in Supabase */
async function processAndStoreMovies() {
  try {
    console.log('Starting movie processing...');
    
    // First, check if movies already exist
    const { data: existingMovies } = await supabase
      .from('movies')
      .select('content')
      .limit(1);

    if (existingMovies?.length > 0) {
      console.log('Movies already processed');
      return existingMovies;
    }
    
    const response = await fetch('movies.txt');
    const text = await response.text();
    
    const chunks = await splitMovieData(text);
    
    console.log('Creating embeddings...');
    const data = [];
    
    for (const chunk of chunks) {
      try {
        const embeddingData = await createEmbeddingWithRetry(chunk);
        data.push(embeddingData);
        console.log(`Processed chunk ${data.length}/${chunks.length}`);
      } catch (error) {
        console.error('Error processing chunk:', error);
        continue;
      }
    }

    console.log('Storing in Supabase...');
    const { error } = await supabase
      .from('movies')
      .insert(data);
    
    if (error) throw error;
    
    console.log(`Successfully processed ${data.length} movies`);
    return data;
  } catch (error) {
    console.error('Error in processAndStoreMovies:', error);
    throw error;
  }
}

async function createEmbeddingWithRetry(chunk, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await rateLimiter.waitForToken();
      
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: chunk.pageContent
      });
      
      return {
        content: chunk.pageContent,
        embedding: embeddingResponse.data[0].embedding
      };
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

export { processAndStoreMovies };