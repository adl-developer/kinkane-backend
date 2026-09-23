import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The XML in these fixtures is trimmed from real BookData Online responses
 * captured against the trial account, including the two different ways it
 * says "no review": omitting the element, and returning a placeholder string.
 */
const BASE_ENV = { ...process.env };

const CREDENTIALS = {
  NIELSEN_REVIEWS_ENABLED: 'true',
  NIELSEN_CLIENT_ID: 'test-client',
  NIELSEN_PASSWORD: 'test-password&with-ampersand',
};

async function loadNielsen(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...CREDENTIALS, ...overrides };
  return import('../lib/nielsen');
}

function respondWith(body: string) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function envelope(inner: string, resultCode = '00') {
  return `<Result><clientId>test-client</clientId><format>7</format><resultCode>${resultCode}</resultCode><hits>1</hits><from>0</from><to>1</to><data><data><record><ISBN13>9781529934090</ISBN13>${inner}</record></data></data></Result>`;
}

afterEach(() => {
  process.env = { ...BASE_ENV };
  vi.unstubAllGlobals();
});

describe('fetchReviewByIsbn', () => {
  it('returns the decoded review text and the field it came from', async () => {
    const { fetchReviewByIsbn } = await loadNielsen();
    respondWith(
      envelope(
        '<NBDFREV>&lt;p&gt;Gorgeously poetic... I was knocked out * Sunday Times *&lt;/p&gt;</NBDFREV>',
      ),
    );

    const review = await fetchReviewByIsbn('9781529934090');

    expect(review).not.toBeNull();
    expect(review?.sourceField).toBe('NBDFREV');
    // Entities are decoded, so the stored value is HTML the client can render
    // the same way it already renders longDescription.
    expect(review?.reviewHtml).toBe('<p>Gorgeously poetic... I was knocked out * Sunday Times *</p>');
  });

  it('treats the "No reviews available" placeholder as no review', async () => {
    const { fetchReviewByIsbn } = await loadNielsen();
    respondWith(envelope('<NBDFREV>No reviews available</NBDFREV>'));

    await expect(fetchReviewByIsbn('9780007453627')).resolves.toBeNull();
  });

  it('treats an absent review element as no review', async () => {
    const { fetchReviewByIsbn } = await loadNielsen();
    respondWith(envelope('<NBDFSD>&lt;p&gt;A brief description.&lt;/p&gt;</NBDFSD>'));

    await expect(fetchReviewByIsbn('9780593446782')).resolves.toBeNull();
  });

  it('falls back to the territory variants when NBDFREV is not the populated one', async () => {
    const { fetchReviewByIsbn } = await loadNielsen();
    respondWith(envelope('<AUSFREV>&lt;p&gt;An Australian review.&lt;/p&gt;</AUSFREV>'));

    const review = await fetchReviewByIsbn('9781529934090');

    expect(review?.sourceField).toBe('AUSFREV');
  });

  it('raises a distinct error when the daily allowance is spent', async () => {
    const { fetchReviewByIsbn, NielsenLimitExceededError } = await loadNielsen();
    respondWith(envelope('', '50'));

    await expect(fetchReviewByIsbn('9781529934090')).rejects.toBeInstanceOf(
      NielsenLimitExceededError,
    );
  });

  it('raises a request error for a rejected logon', async () => {
    const { fetchReviewByIsbn, NielsenRequestError } = await loadNielsen();
    respondWith(envelope('', '02'));

    await expect(fetchReviewByIsbn('9781529934090')).rejects.toBeInstanceOf(NielsenRequestError);
  });

  it('sends the long result view, since the review field is absent from the others', async () => {
    const { fetchReviewByIsbn } = await loadNielsen();
    const fetchMock = respondWith(envelope('<NBDFREV>No reviews available</NBDFREV>'));

    await fetchReviewByIsbn('9781529934090');

    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get('resultView')).toBe('2');
    expect(url.searchParams.get('field0')).toBe('1');
    expect(url.searchParams.get('value0')).toBe('9781529934090');
    // A password containing '&' has to survive into the query string intact,
    // or the request silently becomes an unauthenticated one with a truncated
    // password and an extra parameter.
    expect(url.searchParams.get('password')).toBe('test-password&with-ampersand');
  });

  it('starts from https so the credentials do not make an unencrypted first hop', async () => {
    const { fetchReviewByIsbn } = await loadNielsen();
    const fetchMock = respondWith(envelope('<NBDFREV>No reviews available</NBDFREV>'));

    await fetchReviewByIsbn('9781529934090');

    expect((fetchMock.mock.calls[0][0] as URL).protocol).toBe('https:');
  });
});
