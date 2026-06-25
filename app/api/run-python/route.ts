import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

export async function POST(req: Request) {
  let tempDirPath = '';
  
  try {
    const { code } = await req.json();

    if (!code) {
      return NextResponse.json({ output: "Error: No code provided." }, { status: 400 });
    }

    // 1. Create an isolated temporary directory for this specific script run
    tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'c_ai_python_'));
    const scriptPath = path.join(tempDirPath, 'script.py');

    // 2. Write the Python code to this directory
    await fs.writeFile(scriptPath, code);

    // 3. Execute the Python script INSIDE the temp directory
    const { stdout, stderr } = await execAsync(`python "${scriptPath}"`, { 
        cwd: tempDirPath, // This forces the script to save files here
        timeout: 15000 
    });

    const finalOutput = stdout || stderr || "Script executed successfully with no output.";

    // 4. Scan the directory for any files the script might have generated
    const generatedFiles: { name: string, data: string }[] = [];
    const dirContents = await fs.readdir(tempDirPath);
    
    for (const file of dirContents) {
        // Skip the python script itself
        if (file !== 'script.py') {
            const filePath = path.join(tempDirPath, file);
            const fileBuffer = await fs.readFile(filePath);
            
            // Convert file to base64 so it can be sent safely over JSON
            generatedFiles.push({
                name: file,
                data: fileBuffer.toString('base64')
            });
        }
    }

    // 5. Return both the text output and the files
    return NextResponse.json({ 
        output: finalOutput,
        files: generatedFiles
    });

  } catch (error: any) {
    return NextResponse.json({ 
        output: error.stderr || error.message || "An unknown error occurred during execution." 
    }, { status: 500 });
  } finally {
    // 6. Clean up: Delete the temp folder and everything inside it so your hard drive doesn't fill up
    if (tempDirPath) {
      try {
        await fs.rm(tempDirPath, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error("Failed to delete temp dir:", cleanupError);
      }
    }
  }
}