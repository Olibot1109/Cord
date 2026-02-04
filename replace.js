// file-patcher.js
const fs = require('fs');
const path = require('path');

function parseReplaceFile(content) {
    const lines = content.split('\n');
    const operations = [];
    let currentOp = null;
    let buffer = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Check if line is a line number (starts with digit)
        if (/^\d+$/.test(line)) {
            // Save previous operation if exists
            if (currentOp && buffer.length > 0) {
                currentOp.code = buffer.join('\n');
                operations.push(currentOp);
            }
            
            // Start new operation
            currentOp = {
                lineNumber: parseInt(line),
                code: ''
            };
            buffer = [];
        }
        // Check if line is a file path (starts with digit and has path)
        else if (/^\d+\s+/.test(line)) {
            // Save previous operation if exists
            if (currentOp && buffer.length > 0) {
                currentOp.code = buffer.join('\n');
                operations.push(currentOp);
            }
            
            const match = line.match(/^(\d+)\s+(.+)$/);
            if (match) {
                // This is a file header
                if (currentOp) {
                    operations.push(currentOp);
                }
                currentOp = {
                    lineNumber: parseInt(match[1]),
                    file: match[2],
                    code: ''
                };
                buffer = [];
            }
        }
        else {
            // This is code content
            buffer.push(lines[i]); // Keep original indentation
        }
    }
    
    // Don't forget the last operation
    if (currentOp && buffer.length > 0) {
        currentOp.code = buffer.join('\n');
        operations.push(currentOp);
    }
    
    return operations;
}

function groupByFile(operations) {
    const files = {};
    
    let currentFile = null;
    
    for (const op of operations) {
        if (op.file) {
            currentFile = op.file;
        }
        
        if (!currentFile) {
            console.error('No file specified for operation at line', op.lineNumber);
            continue;
        }
        
        if (!files[currentFile]) {
            files[currentFile] = [];
        }
        
        files[currentFile].push({
            lineNumber: op.lineNumber,
            code: op.code
        });
    }
    
    return files;
}

function applyReplacements(filePath, replacements) {
    // Read original file
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        console.error(`Cannot read file: ${filePath}`);
        console.error('Make sure the file exists and path is correct');
        return false;
    }
    
    const lines = content.split('\n');
    
    // Sort replacements by line number (descending) to avoid offset issues
    replacements.sort((a, b) => b.lineNumber - a.lineNumber);
    
    for (const rep of replacements) {
        const lineIdx = rep.lineNumber - 1; // Convert to 0-based index
        
        if (lineIdx < 0 || lineIdx >= lines.length) {
            console.warn(`Line ${rep.lineNumber} is out of range in ${filePath}`);
            continue;
        }
        
        // Replace the line(s) at this position
        const newLines = rep.code.split('\n');
        
        // Remove trailing empty line if present
        if (newLines[newLines.length - 1] === '') {
            newLines.pop();
        }
        
        lines.splice(lineIdx, 1, ...newLines);
        
        console.log(`  Replaced line ${rep.lineNumber} in ${filePath} (${newLines.length} lines)`);
    }
    
    // Write back
    const newContent = lines.join('\n');
    
    // Create backup
    const backupPath = filePath + '.backup.' + Date.now();
    fs.writeFileSync(backupPath, content);
    console.log(`  Backup created: ${backupPath}`);
    
    // Write new content
    fs.writeFileSync(filePath, newContent);
    console.log(`  Updated: ${filePath}`);
    
    return true;
}

function main() {
    const replaceFile = 'replace.txt';
    
    if (!fs.existsSync(replaceFile)) {
        console.error(`Cannot find ${replaceFile}`);
        console.log('\nCreate a replace.txt file with this format:');
        console.log('0 js/main.js');
        console.log('382');
        console.log('function hiii() {');
        console.log('  alert("e")');
        console.log('}');
        console.log('385');
        console.log('// etc...');
        process.exit(1);
    }
    
    console.log(`Reading ${replaceFile}...`);
    const content = fs.readFileSync(replaceFile, 'utf8');
    
    const operations = parseReplaceFile(content);
    console.log(`Found ${operations.length} operations\n`);
    
    const files = groupByFile(operations);
    
    console.log('Files to patch:');
    Object.keys(files).forEach(f => console.log(`  - ${f} (${files[f].length} replacements)`));
    console.log('');
    
    // Apply replacements
    for (const [filePath, replacements] of Object.entries(files)) {
        console.log(`\nPatching ${filePath}...`);
        applyReplacements(filePath, replacements);
    }
    
    console.log('\n✓ Done!');
}

main();