import { ref, resp, json, body, object, param, publicEndpoint } from '../helpers';

const TAG = 'Support';

export const supportPaths = {
  '/api/v1/contact': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Send a message through the Contact Us form',
      description: [
        'Public — the people most likely to need this are the ones who cannot get into their account. Send a token anyway when you have one and the message is attached to the account, so support can see who they are talking to rather than trusting the name in the form.',
        '',
        '**Rate limited to 3 an hour per IP.** Generous for a person with a problem, useless to a script.',
        '',
        '`website` is a honeypot: hide it from real users with CSS and leave it empty. Anything in it means the submission is dropped — and answered with the same `201`, because telling a bot which field gave it away is free tuning information.',
        '',
        'The message is stored before it is emailed and a failed send does **not** fail the request: from the sender’s side the message was sent, and it was.',
      ].join('\n'),
      requestBody: body(object({
        name: { type: 'string', minLength: 1, maxLength: 200, example: 'Ama Boateng' },
        email: { type: 'string', format: 'email', maxLength: 254, example: 'ama@example.com' },
        subject: { type: 'string', minLength: 1, maxLength: 200, example: 'Where is my order?' },
        message: { type: 'string', minLength: 1, maxLength: 5000, example: 'ORD-7K2M9QX4 was due last week…' },
        website: {
          type: 'string', maxLength: 200,
          description: 'Honeypot. Leave empty; hide it from real users.',
          example: '',
        },
      }, ['name', 'email', 'subject', 'message'])),
      responses: {
        201: json('Received. Returned for dropped honeypot submissions too.',
          object({ received: { type: 'boolean', example: true } })),
        400: json('Validation failed.', ref('ValidationError')),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },
  '/api/v1/books/{id}/restock-requests': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Ask for an out-of-stock book to be restocked',
      description: [
        'The **Request Restock** button beside a greyed-out **Out of Stock** button on the book page, on the website and in the app. Public: send a token when you have one.',
        '',
        '**Show the button only when the selected edition has `availableQuantity: 0`** and the book is otherwise for sale. The server holds the same line and refuses anything else, so a stale page cannot file a request for a book that can be bought or can never come back. If the button gets a `409`, hide it:',
        '',
        '| Edition | Answer |',
        '| --- | --- |',
        '| Out of stock, reprinting, or out of stock indefinitely | `201` |',
        '| In stock, or supplied to order (extended catalogue, print on demand) | `409 IN_STOCK`: the customer can simply order it |',
        '| Out of print, cancelled, not yet published, postponed, or refer to publisher | `409 UNAVAILABLE`: no restock will bring it back |',
        '| Not licensed for sale in the caller’s country | `409 MARKET_RESTRICTED`. Only when the country is known and mapped to Gardners regions; not knowing where someone is never turns them away |',
        '| No price | `409 NOT_FOR_SALE` |',
        '| Withdrawn, or no such book | `404 BOOK_NOT_FOUND` |',
        '',
        '**The form is optional, both fields.** A customer signed in to a real account can send `{}` and is filed under the account’s name and email, so skip the form for them. The web shop’s silent guest accounts are not real accounts for this purpose: show them the form, as for anyone signed out.',
        '',
        '**Every press is stored.** There is no de-duplication by design, and no "already requested" state to read back: repeat requests are how the admin sees demand. Rate limited to **20 an hour per IP**, which only a script will reach.',
        '',
        '`website` is a honeypot, as on the contact form: leave it empty and hide it.',
        '',
        '**Emails.** Every request emails the Kinkané team (from contactus@, to `RESTOCK_INBOX`) with who asked, the cover, title, author and a link to the book. When there is an address — the form’s, or a signed-in account’s — the customer also gets a short confirmation from no-reply@, capped at **3 a day per address** so the form cannot be used to mail a stranger; past the cap the request is still stored. A failed send never fails the request.',
        '',
        '**Confirmation copy.** The confirmation email does not promise a notification when the book is back, because nobody sends one: the admin contacts the customer by hand. Match that on screen. The agreed wording is: *"Request sent. We’ve told the Kinkané team you’re after the Paperback."* (with the edition’s format).',
      ].join('\n'),
      parameters: [param('id', 'path', { type: 'integer' }, 'The **edition** the customer is looking at: the selected format’s book id.', { required: true })],
      requestBody: body(object({
        name: { type: 'string', maxLength: 200, example: 'Amara Diallo', description: 'Optional. Empty means not given.' },
        email: { type: 'string', format: 'email', maxLength: 254, example: 'amara.diallo@email.com', description: 'Optional. Empty means not given.' },
        website: { type: 'string', maxLength: 200, description: 'Honeypot. Leave empty; hide it from real users.', example: '' },
      }), { required: false }),
      responses: {
        201: json('Requested. Returned for dropped honeypot submissions too.',
          object({ requested: { type: 'boolean', example: true } })),
        400: json('Invalid book id, or an email that is not one.', ref('ValidationError')),
        404: json('No such book, or it has been withdrawn.', ref('Error'), { error: 'Book not found', code: 'BOOK_NOT_FOUND' }),
        409: json(
          'This edition cannot be requested. Branch on `code`: `IN_STOCK`, `UNAVAILABLE`, `NOT_FOR_SALE` or `MARKET_RESTRICTED`.',
          ref('Error'),
          { error: 'This book can be ordered now, so there is nothing to restock', code: 'IN_STOCK' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },
};
