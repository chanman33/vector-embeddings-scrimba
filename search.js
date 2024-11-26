import { openai, supabase } from './config.js';
import { rateLimiter } from './rateLimiter.js';

async function generateMovieResponse(movies, query) {
  const context = movies.map(movie => movie.content).join('\n\n');
  
  const messages = [
    {
      role: 'system',
      content: `You are a knowledgeable movie expert who helps users find and understand movies. 
                Provide concise, natural responses that directly answer the user's question using the 
                provided movie information. If the context doesn't contain relevant information, 
                politely say so. Include specific movie details when possible. 
                Keep responses under 3 sentences.`
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
      max_tokens: 150
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Movie chat completion error:', error);
    throw error;
  }
}

async function searchMovies(query, limit = 3) {
  if (!query?.trim()) {
    throw new Error('Search query is required');
  }

  try {
    await rateLimiter.waitForToken();
    const embedding = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: query,
    });

    const { data: similarMovies, error } = await supabase
      .rpc('match_movies', {
        query_embedding: embedding.data[0].embedding,
        match_threshold: 0.5,
        match_count: limit
      });

    if (error) {
      console.error('Supabase search error:', error);
      throw new Error('Failed to search movies');
    }

    if (!similarMovies?.length) {
      return {
        movies: [],
        response: "I couldn't find any movies matching your query. Try a different search term."
      };
    }

    const chatResponse = await generateMovieResponse(similarMovies, query);
    
    return {
      movies: similarMovies,
      response: chatResponse
    };
    
  } catch (error) {
    console.error('Search error:', error);
    throw error;
  }
}

export { searchMovies };