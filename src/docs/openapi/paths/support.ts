import { ref, resp, json, body, object, publicEndpoint } from '../helpers';

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
};
