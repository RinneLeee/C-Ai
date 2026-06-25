import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const chatId = searchParams.get('chatId');

    if (!chatId) {
      return Response.json({ error: 'Missing chatId' }, { status: 400 });
    }

    const { data: messages, error } = await supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return Response.json({ messages });
  } catch (error) {
    console.error('History API Error:', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}