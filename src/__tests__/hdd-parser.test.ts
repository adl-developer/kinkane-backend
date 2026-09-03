import { describe, it, expect } from 'vitest';
import {
  parseHddFile,
  extractCarrier,
  extractTrackingNumber,
  extractTrackingUrl,
} from '../services/gardners-dropship/hdd-parser';

/**
 * The example dispatch file printed in the I12 specification (page 19),
 * verbatim. If the parser cannot read the spec's own example it cannot read
 * anything Gardners sends.
 */
const SPEC_EXAMPLE =
  '"HEADER","ACC123","01/01/2020"\r\n' +
  '"DETAIL",31722783,000109,"ABC123456","ABS123456",246875231,"9780340911709",1,"17/01/2020",799,290,4400,' +
  '"Dispatched Royal Mail 48 Tracked","Contact Royal Mail On:",' +
  '"www.royalmail.com/track-your-item","     Tracking Number: NU815785655GB"\r\n' +
  '"TRAILER",000001\r\n';

describe('parseHddFile — the specification example', () => {
  const result = parseHddFile(SPEC_EXAMPLE);

  it('reads the header', () => {
    expect(result.accountCode).toBe('ACC123');
    expect(result.fileDate).toBe('2020-01-01'); // DD/MM/YYYY → ISO
  });

  it('reads every DETAIL field in the documented order', () => {
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    expect(line.dispatchNo).toBe('31722783');
    expect(line.uniqueReference).toBe('000109');
    expect(line.additionalReference).toBe('ABC123456');
    expect(line.batchRef).toBe('ABS123456');
    expect(line.gardnersRef).toBe('246875231');
    expect(line.isbn13).toBe('9780340911709');
    expect(line.quantity).toBe(1);
    expect(line.dispatchedOn).toBe('2020-01-17');
    expect(line.pricePence).toBe(799);
    expect(line.deliveryPence).toBe(290);
    expect(line.discountBasisPoints).toBe(4400);
  });

  it('recovers carrier, tracking number and URL from the prose', () => {
    const line = result.lines[0];
    // "Contact Royal Mail On:" wins over "Dispatched Royal Mail 48 Tracked",
    // which mixes the service level into the carrier name.
    expect(line.carrier).toBe('Royal Mail');
    expect(line.trackingNumber).toBe('NU815785655GB');
    expect(line.trackingUrl).toBe('https://www.royalmail.com/track-your-item');
  });

  it('keeps the raw description lines', () => {
    expect(result.lines[0].descriptionLines).toHaveLength(4);
    expect(result.lines[0].descriptionLines[0]).toBe('Dispatched Royal Mail 48 Tracked');
  });

  it('reads the trailer count', () => {
    expect(result.trailerCount).toBe(1);
  });
});

describe('extractCarrier', () => {
  it('prefers the "Contact X On:" phrasing', () => {
    expect(extractCarrier(['Dispatched DPD Next Day', 'Contact DPD On: 0121 275 0500'])).toBe('DPD');
  });

  it('falls back to DETAIL1 without its "Dispatched" prefix', () => {
    // Too long to be a pure carrier name, but far better than null — the
    // customer still learns who has their parcel.
    expect(extractCarrier(['Dispatched Royal Mail 48 Tracked'])).toBe('Royal Mail 48 Tracked');
  });

  it('returns null when there is nothing to read', () => {
    expect(extractCarrier([])).toBeNull();
    expect(extractCarrier([''])).toBeNull();
  });
});

describe('extractTrackingNumber', () => {
  it('reads the documented label', () => {
    expect(extractTrackingNumber(['     Tracking Number: NU815785655GB'])).toBe('NU815785655GB');
  });

  it('reads the other labels the spec mentions', () => {
    // "the shipper parcel/reference number and/or Recorded Delivery number"
    expect(extractTrackingNumber(['Consignment No: 1234567890'])).toBe('1234567890');
    expect(extractTrackingNumber(['Parcel Reference: DPD-99887766'])).toBe('DPD-99887766');
    expect(extractTrackingNumber(['Recorded Delivery Number: RD123456789GB'])).toBe(
      'RD123456789GB',
    );
  });

  it('does not mistake a phone number for a tracking number', () => {
    // The single most dangerous false positive available: "Contact ... On:"
    // sits next to the tracking line in every real dispatch file, and a
    // shape-based matcher happily grabs the phone number.
    expect(extractTrackingNumber(['Contact Royal Mail On: 03457 740740'])).toBeNull();
  });

  it('returns null rather than guessing when no label is present', () => {
    expect(extractTrackingNumber(['Dispatched Royal Mail 48 Tracked'])).toBeNull();
    expect(extractTrackingNumber([])).toBeNull();
  });

  it('strips trailing punctuation', () => {
    expect(extractTrackingNumber(['Tracking Number: NU815785655GB.'])).toBe('NU815785655GB');
  });
});

describe('extractTrackingUrl', () => {
  it('makes a bare host absolute', () => {
    // orders.tracking_url is rendered as a link; stored bare it would resolve
    // against our own domain and 404.
    expect(extractTrackingUrl(['www.royalmail.com/track-your-item'])).toBe(
      'https://www.royalmail.com/track-your-item',
    );
  });

  it('keeps an existing scheme', () => {
    expect(extractTrackingUrl(['https://track.dpd.co.uk/parcels/123'])).toBe(
      'https://track.dpd.co.uk/parcels/123',
    );
  });

  it('refuses a non-http scheme', () => {
    // Supplier prose ends up in an href. A javascript: payload must not survive.
    expect(extractTrackingUrl(['javascript:alert(1)'])).toBeNull();
    expect(extractTrackingUrl(['Contact us on ftp://files.example.com'])).toBeNull();
  });

  it('returns null when there is no URL', () => {
    expect(extractTrackingUrl(['Tracking Number: NU815785655GB'])).toBeNull();
  });
});

describe('parseHddFile — real-world robustness', () => {
  it('handles several dispatches across several orders in one file', () => {
    // The spec is explicit that one file carries dispatches for many different
    // customer orders, and that items in one shipment need not be adjacent.
    const raw =
      '"HEADER","ACC123","02/02/2026"\r\n' +
      '"DETAIL",900,000011,"A","B",1,"9780000000001",1,"02/02/2026",100,0,0,"Dispatched DPD","Contact DPD On:","www.dpd.co.uk/t","Tracking Number: AAA111"\r\n' +
      '"DETAIL",901,000022,"A","B",2,"9780000000002",2,"02/02/2026",200,0,0,"Dispatched Evri","Contact Evri On:","www.evri.com/t","Tracking Number: BBB222"\r\n' +
      '"DETAIL",900,000033,"A","B",3,"9780000000003",1,"02/02/2026",300,0,0,"Dispatched DPD","Contact DPD On:","www.dpd.co.uk/t","Tracking Number: AAA111"\r\n' +
      '"TRAILER",000003\r\n';

    const result = parseHddFile(raw);
    expect(result.lines).toHaveLength(3);
    expect(result.lines.map((l) => l.uniqueReference)).toEqual(['000011', '000022', '000033']);
    // Lines 1 and 3 share dispatch 900 — one parcel, two books.
    expect(result.lines[0].dispatchNo).toBe(result.lines[2].dispatchNo);
    expect(result.lines[0].trackingNumber).toBe(result.lines[2].trackingNumber);
    expect(result.lines[1].carrier).toBe('Evri');
  });

  it('accepts a dispatch with no tracking at all', () => {
    // Untracked services are normal. "Dispatched, no tracking" is true and
    // useful; inventing a tracking number is not.
    const raw =
      '"HEADER","ACC123","02/02/2026"\r\n' +
      '"DETAIL",900,000011,"","",0,"9780000000001",1,"02/02/2026",100,0,0,"Dispatched Royal Mail 48","","",""\r\n' +
      '"TRAILER",000001\r\n';

    const line = parseHddFile(raw).lines[0];
    expect(line.carrier).toBe('Royal Mail 48');
    expect(line.trackingNumber).toBeNull();
    expect(line.trackingUrl).toBeNull();
    expect(line.additionalReference).toBeNull();
    expect(line.gardnersRef).toBeNull(); // "0" means none, per the ACK convention
  });

  it('drops a record with no unique reference instead of guessing', () => {
    // Without it the dispatch cannot be attributed to an order line, and
    // attaching tracking to the wrong customer is worse than losing the record.
    const raw =
      '"HEADER","ACC123","02/02/2026"\r\n' +
      '"DETAIL",900,,"","",0,"9780000000001",1,"02/02/2026",100,0,0,"Dispatched","","",""\r\n' +
      '"TRAILER",000001\r\n';

    expect(parseHddFile(raw).lines).toHaveLength(0);
  });

  it('survives LF-only line endings and an absent trailer', () => {
    const raw =
      '"HEADER","ACC123","02/02/2026"\n' +
      '"DETAIL",900,000011,"","",0,"9780000000001",1,"02/02/2026",100,0,0,"Dispatched DPD","","",""\n';

    const result = parseHddFile(raw);
    expect(result.lines).toHaveLength(1);
    expect(result.trailerCount).toBeNull();
  });

  it('skips unrecognised record types rather than throwing', () => {
    const raw =
      '"HEADER","ACC123","02/02/2026"\r\n' +
      '"SOMETHINGNEW","whatever"\r\n' +
      '"DETAIL",900,000011,"","",0,"9780000000001",1,"02/02/2026",100,0,0,"Dispatched DPD","","",""\r\n' +
      '"TRAILER",000001\r\n';

    expect(parseHddFile(raw).lines).toHaveLength(1);
  });

  it('always keeps the raw file', () => {
    expect(parseHddFile(SPEC_EXAMPLE).raw).toBe(SPEC_EXAMPLE);
  });

  it('returns an empty result for an empty file rather than throwing', () => {
    const result = parseHddFile('');
    expect(result.lines).toEqual([]);
    expect(result.accountCode).toBeNull();
  });
});
