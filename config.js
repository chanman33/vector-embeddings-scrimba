import OpenAI from 'openai';
import { createClient } from "@supabase/supabase-js";

const requiredEnvVars = {
  OPENAI_API_KEY: import.meta.env.VITE_OPENAI_API_KEY,
  SUPABASE_API_KEY: import.meta.env.VITE_SUPABASE_API_KEY,
  SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL
};

Object.entries(requiredEnvVars).forEach(([key, value]) => {
  if (!value) {
    console.error(`Missing ${key} environment variable`);
    throw new Error(`Missing ${key} environment variable`);
  }
});

export const openai = new OpenAI({
  apiKey: requiredEnvVars.OPENAI_API_KEY,
  dangerouslyAllowBrowser: true
});

export const supabase = createClient(
  requiredEnvVars.SUPABASE_URL,
  requiredEnvVars.SUPABASE_API_KEY,
  {
    auth: {
      persistSession: false
    },
    db: {
      schema: 'public'
    }
  }
);

// Test database connection
async function testConnection() {
  const { data, error } = await supabase
    .from('documents')
    .select('id')
    .limit(1);
    
  if (error) {
    console.error('Supabase connection error:', error);
  } else {
    console.log('Supabase connected successfully');
  }
}

testConnection();