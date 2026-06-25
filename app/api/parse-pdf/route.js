import { NextResponse } from 'next/server';
import { createRequire } from 'module';

// =======================================================================
// CRITICAL FIX 1: Polyfill browser Canvas/Matrix APIs missing in Node.js.
// =======================================================================
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {};
}
if (typeof global.ImageData === 'undefined') {
  global.ImageData = class ImageData {};
}
if (typeof global.Path2D === 'undefined') {
  global.Path2D = class Path2D {};
}

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // =======================================================================
    // THE ULTIMATE TURBOPACK BYPASS
    // By splitting the string, Turbopack's static analyzer is completely blind.
    // It is forced to skip bundling and let Node.js load it natively at runtime.
    // =======================================================================
    const requireNode = createRequire(import.meta.url);
    const libName = 'pdf' + '-parse'; 
    const pdfParse = requireNode(libName);
    
    // Parse the PDF buffer natively
    // FIX: Handle CJS/ESM interop wrapping where the function might be under .default
    const parseFunction = pdfParse.default || pdfParse;
    const pdfData = await parseFunction(buffer);

    return NextResponse.json({ text: pdfData.text });
  } catch (error) {
    console.error('🔥 PDF Parse Error Details:', error);
    
    return NextResponse.json(
      { 
        error: 'Failed to parse PDF backend', 
        message: error.message,
        name: error.name
      },
      { status: 500 }
    );
  }
}