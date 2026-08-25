import { describe, it, expect } from 'vitest';
import { bucketDeviceType } from '../../utils/deviceType';

describe('bucketDeviceType', () => {
  it('returns unknown for a missing User-Agent', () => {
    expect(bucketDeviceType(null)).toBe('unknown');
  });

  it('detects common bots before mobile/tablet, since some bot UAs also contain "mobile"', () => {
    expect(bucketDeviceType('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe('bot');
    expect(bucketDeviceType('facebookexternalhit/1.1')).toBe('bot');
  });

  it('detects tablets, including Android tablets that omit "Mobile"', () => {
    expect(bucketDeviceType('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(bucketDeviceType('Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36')).toBe('tablet');
  });

  it('detects mobile phones', () => {
    expect(bucketDeviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
    expect(bucketDeviceType('Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Mobile')).toBe('mobile');
  });

  it('falls back to desktop for an ordinary browser UA', () => {
    expect(bucketDeviceType('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')).toBe('desktop');
  });
});
