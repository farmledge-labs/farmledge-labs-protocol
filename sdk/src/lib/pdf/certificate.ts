import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { TokenRecord } from '../../types';

export async function generateCertificatePdf(tokenRecord: TokenRecord): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 400]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();

  // Header
  page.drawText('WAREHOUSE RECEIPT CERTIFICATE', {
    x: 50,
    y: height - 50,
    size: 20,
    font: boldFont,
    color: rgb(0.1, 0.3, 0.6),
  });

  page.drawLine({
    start: { x: 50, y: height - 60 },
    end: { x: width - 50, y: height - 60 },
    thickness: 1.5,
    color: rgb(0.1, 0.3, 0.6),
  });

  // Data rows
  const receipt = tokenRecord.receipt;
  const details = [
    ['Token ID:', tokenRecord.tokenId],
    ['Receipt ID:', receipt.id],
    ['Commodity:', receipt.commodity],
    ['Quantity:', `${receipt.quantity} ${receipt.unit}`],
    ['Grade Code:', receipt.gradeCode],
    ['Custodian:', receipt.custodian],
    ['Depositor:', receipt.depositor],
    ['Owner:', tokenRecord.owner],
    ['Issued At:', new Date(receipt.issuedAt * 1000).toISOString()],
    ['Expires At:', new Date(receipt.expiresAt * 1000).toISOString()],
  ];

  let yOffset = height - 90;
  for (const [label, value] of details) {
    page.drawText(label, {
      x: 50,
      y: yOffset,
      size: 11,
      font: boldFont,
      color: rgb(0.2, 0.2, 0.2),
    });
    page.drawText(String(value), {
      x: 160,
      y: yOffset,
      size: 11,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    yOffset -= 22;
  }

  // Footer
  page.drawText('FarmLedge Labs Protocol - Authenticated Certificate', {
    x: 50,
    y: 30,
    size: 9,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}
