import { generateCertificatePdf } from '../src/lib/pdf/certificate';
import { TokenRecord } from '../src/types';
import { PDFDocument } from 'pdf-lib';

describe('PDF certificate generator utility', () => {
  it('generates a valid PDF byte array from TokenRecord data', async () => {
    const mockTokenRecord: TokenRecord = {
      tokenId: 'TOKEN-12345',
      owner: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      receipt: {
        id: 'WR-998877',
        commodity: 'Yellow Corn',
        quantity: 500,
        unit: 'MT',
        gradeCode: 'GRADE-A',
        custodian: 'GCUSTODIAN1234567890',
        depositor: 'GDEPOSITOR1234567890',
        issuedAt: 1700000000,
        expiresAt: 1735689600,
      },
    };

    const pdfBytes = await generateCertificatePdf(mockTokenRecord);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(0);

    // Verify loading generated PDF structure back
    const pdfDoc = await PDFDocument.load(pdfBytes);
    expect(pdfDoc.getPageCount()).toBe(1);
  });
});
