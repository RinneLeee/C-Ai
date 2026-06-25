import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // 1. Fetch DeepSeek Usage
    let deepseekData = null;
    if (process.env.DEEPSEEK_API_KEY) {
      const dsRes = await fetch('https://api.deepseek.com/user/balance', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        }
      });
      if (dsRes.ok) {
        deepseekData = await dsRes.json();
      } else {
        deepseekData = { error: 'Failed to fetch from DeepSeek API' };
      }
    } else {
      deepseekData = { error: 'DEEPSEEK_API_KEY not configured in .env' };
    }

    // 2. Qwen DashScope Usage
    // Note: DashScope does not provide a standard /balance endpoint via their OpenAI proxy.
    const qwenData = {
      message: "DashScope does not expose a public billing endpoint via the standard API key.",
      consoleUrl: "https://dashscope.console.aliyun.com/billing"
    };

    return NextResponse.json({
      deepseek: deepseekData,
      qwen: qwenData
    });

  } catch (error) {
    console.error("Usage API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}