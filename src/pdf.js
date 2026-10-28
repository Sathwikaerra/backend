import fs from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { badRequest } from './utils.js'

export const MAX_PDF_BYTES = 15 * 1024 * 1024

// Checks the bytes are a readable, unprotected PDF within the size limit; returns its page count
export async function checkPdf(data) {
  if (!Buffer.isBuffer(data) || !data.length) throw badRequest('Send a PDF file')
  if (data.length > MAX_PDF_BYTES) throw badRequest(`The PDF must be at most ${MAX_PDF_BYTES / 1024 / 1024} MB`)
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('This file is not a PDF')
  try {
    return (await PDFDocument.load(data)).getPageCount()
  } catch (err) {
    throw badRequest(/encrypt/i.test(err.message) ? 'The PDF is password-protected. Send an unprotected PDF.' : 'The PDF could not be read')
  }
}

/*
 * Turns a PDF into the base64 text that POST /api/v1/contracts expects in document.base64.
 * input: a Buffer (pass its fileName too) or a file path.
 * Returns { fileName, sizeBytes, pages, base64 }.
 */
export async function pdfToBase64(input, fileName) {
  let data = input
  if (typeof input === 'string') {
    data = await fs.readFile(input)
    fileName ??= path.basename(input)
  }
  const pages = await checkPdf(data)
  return { fileName: fileName || 'document.pdf', sizeBytes: data.length, pages, base64: data.toString('base64') }
}
