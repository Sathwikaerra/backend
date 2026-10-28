// Converts a PDF to base64 for testing POST /api/v1/contracts.
// Usage: npm run pdf:base64 -- <file.pdf> [--json]
//   writes <file>.base64.txt next to the PDF; --json also writes <file>.document.json = { fileName, base64 },
//   ready to paste as the "document" field.
import fs from 'node:fs/promises'
import { pdfToBase64 } from '../pdf.js'

const [file, flag] = process.argv.slice(2)
if (!file) {
  console.error('Usage: npm run pdf:base64 -- <file.pdf> [--json]')
  process.exit(1)
}

try {
  const { fileName, sizeBytes, pages, base64 } = await pdfToBase64(file)
  const stem = file.replace(/\.pdf$/i, '')
  await fs.writeFile(`${stem}.base64.txt`, base64)
  console.log(`${fileName}: ${pages} page(s), ${(sizeBytes / 1024).toFixed(1)} KB -> ${base64.length} base64 characters`)
  console.log(`Wrote ${stem}.base64.txt`)
  if (flag === '--json') {
    await fs.writeFile(`${stem}.document.json`, JSON.stringify({ fileName, base64 }))
    console.log(`Wrote ${stem}.document.json`)
  }
} catch (err) {
  console.error(`Could not convert ${file}: ${err.message}`)
  process.exit(1)
}
