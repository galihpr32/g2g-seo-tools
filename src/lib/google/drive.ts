// ─── Google Drive / Docs client (service account) ─────────────────────────────
// Uses the same service account credentials as sheets.ts.
//
// Required env vars (same as sheets.ts):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//
// Optional env vars:
//   GOOGLE_DRIVE_FOLDER_ID  — Drive folder ID to put generated docs into.
//                             If not set, docs land in the service account's root drive
//                             (which may not be accessible to humans — set this!).
//
// Required scope: https://www.googleapis.com/auth/drive
// The getAuth() in this file requests the drive scope.
// Note: this is separate from sheets.ts auth (different scope).

import { google } from 'googleapis'

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!email || !key) throw new Error('Google service account credentials not configured')

  return new google.auth.JWT({
    email,
    key,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ],
  })
}

export interface ProductDocContent {
  productName:          string
  category:             string
  relationId:           string
  mainKeyword:          string
  secondaryKeyword:     string
  metaTitle:            string
  metaDescription:      string
  metaKeywords:         string
  marketingTitle:       string
  marketingDescription: string   // HTML string
}

/**
 * Creates a Google Doc with all product content fields.
 * The doc is placed in GOOGLE_DRIVE_FOLDER_ID (if configured) so humans can access it.
 * Returns the Google Doc URL (https://docs.google.com/document/d/{id}/edit).
 */
export async function createProductDoc(content: ProductDocContent): Promise<string> {
  const auth  = getAuth()
  const drive = google.drive({ version: 'v3', auth })
  const docs  = google.docs({ version: 'v1', auth })

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID

  // ── 1. Create an empty Google Doc ─────────────────────────────────────────
  const title = `[G2G] ${content.productName}`

  const fileRes = await drive.files.create({
    requestBody: {
      name:     title,
      mimeType: 'application/vnd.google-apps.document',
      // Place in configured folder if available
      ...(folderId ? { parents: [folderId] } : {}),
    },
    fields: 'id',
  })

  const docId = fileRes.data.id
  if (!docId) throw new Error('Failed to create Google Doc — no ID returned')

  // ── 2. Strip HTML tags for plain-text body (Docs API doesn't accept HTML) ─
  // We write structured sections with clear headers so it's human-readable.
  function stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  const descriptionPlain = stripHtml(content.marketingDescription)

  // ── 3. Build the document body via batchUpdate ─────────────────────────────
  // We insert text from bottom to top so indexes stay valid, OR we build the
  // entire doc as one insertText at index 1 (simplest approach).

  const body = [
    `PRODUCT: ${content.productName}`,
    `Category: ${content.category}`,
    `Relation ID: ${content.relationId}`,
    '',
    '══ SEO FIELDS ══',
    '',
    `Meta Title: ${content.metaTitle}`,
    `Meta Description: ${content.metaDescription}`,
    `Meta Keywords: ${content.metaKeywords}`,
    '',
    '══ KEYWORDS ══',
    '',
    `Main Keyword: ${content.mainKeyword}`,
    `Secondary Keywords: ${content.secondaryKeyword}`,
    '',
    '══ MARKETING CONTENT ══',
    '',
    `H1 / Marketing Title:`,
    content.marketingTitle,
    '',
    `Marketing Description:`,
    descriptionPlain,
    '',
    '══ RAW HTML (for CMS upload) ══',
    '',
    content.marketingDescription,
  ].join('\n')

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: body,
          },
        },
      ],
    },
  })

  // ── 4. Make the file readable by anyone with the link ──────────────────────
  // This allows the G2G team to open the link from the sheet without needing
  // to be added to the service account's drive individually.
  await drive.permissions.create({
    fileId: docId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  })

  return `https://docs.google.com/document/d/${docId}/edit`
}
