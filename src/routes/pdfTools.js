import express, { Router } from 'express'
import multer from 'multer'
import { MAX_PDF_BYTES, pdfToBase64 } from '../pdf.js'
import { badRequest, handle } from '../utils.js'

/*
 * POST .../pdf-to-base64  -> { fileName, sizeBytes, pages, base64 }
 * Send the PDF either as multipart form data (field "file") or as the raw body with
 * "Content-Type: application/pdf" (name it with ?fileName=loan.pdf).
 * Mounted at /api/v1/tools (API key) and /api/developer (signed in).
 */
const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } })
const raw = express.raw({ type: 'application/pdf', limit: MAX_PDF_BYTES })

router.post(
  '/pdf-to-base64',
  raw,
  upload.single('file'),
  handle(async (req, res) => {
    if (req.file) return res.json(await pdfToBase64(req.file.buffer, req.file.originalname))
    if (Buffer.isBuffer(req.body) && req.body.length) {
      const name = typeof req.query.fileName === 'string' ? req.query.fileName.slice(0, 200) : undefined
      return res.json(await pdfToBase64(req.body, name))
    }
    throw badRequest('Send the PDF as form field "file", or as the body with Content-Type: application/pdf')
  }),
)

export default router
