import { NextResponse } from 'next/server';

// =======================================================================
// CRITICAL FIX: Polyfill browser Canvas/Matrix APIs missing in Node.js.
// pdf-parse requires these classes to initialize without throwing ReferenceErrors.
// This must be completely outside the POST function so it runs on load.
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

    // Convert the uploaded file to a Buffer for pdf-parse
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Use ESM dynamic import instead of CommonJS require to satisfy Turbopack
    const pdfParseModule = await import('pdf-parse');
    const pdfParse = pdfParseModule.default || pdfParseModule;
    
    // Parse the PDF buffer
    const pdfData = await pdfParse(buffer);

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