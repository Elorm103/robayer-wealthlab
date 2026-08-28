import { describe, it, expect } from 'vitest';
import { extractPdfText } from '../../../services/libraryKnowledge/pdfExtraction';

const PDF_BASE64 =
  'JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAxNTgKPj4Kc3RyZWFtCnicdc69CsJADADgPU+RWRCTNJfcgThYFAcX4V5ApIqiQ0V8ftPSRVACIeSHLz2sKxAO8bzAYtfd393rejrOnUrWTJ4LimI9w5D3wOMqoxI2ibA+YJnUkjeuQomMzS0JNbzCeoM6g02FA/T/lBJnliVZRpbfCk2K2NbE2EtoElY4obWulrWNKnouY0+nDVYWMrPi2dXTMP366gOYKzaECmVuZHN0cmVhbQplbmRvYmoKCjggMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAxNTgKPj4Kc3RyZWFtCnicdc69CsJADAfwPU+RWRCTNB93IA4WxcFFuBcQqaLoUBGf32vpIiiBEP4J/NLDugDhUM8LLHbd/d29rqfjXIgokeXkKIrlDEPfA4+njErYGGF5wNLULZpQISNnDzehRlZYblBmsClwgP6fksNIPQsFsvxWaFLEty7Okasm1apO1dpQT9rWqWYhY6bTBSsLuXuOFBo2bL+++gCB0DZnCmVuZHN0cmVhbQplbmRvYmoKCjEwIDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggMTU4Cj4+CnN0cmVhbQp4nHXPvQrCQAwH8D1PkVkQk1w+riAOFsXBRbgXEKmi6FARn99r6SIogRDCH35JD+sChEM9L7DYdfd397qejvOwEEvJs6MoljMMfQ88RhmVMBlhecDS1C1SqJCRs4ebUEorLDcoM9gUOED/T8lqxJmYAll+KzQp4lsX52iqJtWqTtXaUM/a1qnuQsadTglWFnL3JnLo8I/b11Ufh9I2ZwplbmRzdHJlYW0KZW5kb2JqCgoxMSAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvT2JqU3RtCi9OIDcKL0ZpcnN0IDM5Ci9MZW5ndGggNDMxCj4+CnN0cmVhbQp4nNVTTWvcMBC961fMsT0UjWR9lmVhs2u3UEJDUmhJ6MGxxeISpGJrS/rvO7I3WQIpPbQ5FDOSZubNSE9+EoAgQRuowCMo0IoMjDRgwVUUBIEKYbVi/NPP7wH4RbsPE+Mfhn6CG4IiXBK0jH4evzK+TYeYoWLrNTvVbdvc3qU9WxqAKOAHxMWY+kMXRlg1ddMgWkQ0iswgyh3NWzJPJsmnnHS0JrPqaBSzFWK1oVyzmLFLTcnPWH2sr2kmrCmY3YJVbvEf9y171UsP+afz+DXj56nftTnAq91bidKgk46YbYS4fk3XMYY2p/+X3Hz+IcXfMnzyn5sUM+NXh9s8uyUoGD9rp1AywN+Hux8hD13LeB271A9xD/zzEDdxGh4CTzsWwRTZjIHqF93wyzClw9iRkApu7lwWj83fWPSOmFvnSdRzySnnrZLGSW3cMUfb8S8fb7+Fbm5T3Po+v7vKhfESKLHz0A/tWbon3SN9dM9A91YUv4kx5fIeZvXHTCctnjm+iL+nU4ThUHtnnqOjURkv0b4wHffP6Fhtpa4q8xwdpzQKh+LF6Qg88fkFp7c/wQplbmRzdHJlYW0KZW5kb2JqCgoxMiAwIG9iago8PAovU2l6ZSAxMwovUm9vdCAyIDAgUgovSW5mbyAzIDAgUgovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvWFJlZgovTGVuZ3RoIDUzCi9XIFsgMSAyIDIgXQovSW5kZXggWyAwIDEzIF0KPj4Kc3RyZWFtCnicY2Bg+P+fiYGbgQFEMIIIJhDBDCJYGBkEIBKsjAzfISw2RsZ7DECFx4AEyx0GBgC4uQYCCmVuZHN0cmVhbQplbmRvYmoKCnN0YXJ0eHJlZgoxMjQ0CiUlRU9G';

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

describe('extractPdfText', () => {
  it('extracts real per-page text from a genuine 3-page PDF, in the real Workers runtime', async () => {
    const result = await extractPdfText(base64ToArrayBuffer(PDF_BASE64));
    expect(result.totalPages).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[0].pageNumber).toBe(1);
    expect(result.pages[0].text).toContain('Test Page 1');
    expect(result.pages[1].text).toContain('Test Page 2');
    expect(result.pages[2].text).toContain('Test Page 3');
  });
});
