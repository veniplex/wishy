// OpenAPI 3.1 description of the public API v1 (GET /api/v1/openapi.json).

const ref = (n) => ({ $ref: `#/components/schemas/${n}` })
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } })
const arr = (items) => ({ type: 'array', items })
const err = (description) => ({ description, content: { 'application/json': { schema: ref('Error') } } })
const common = {
  401: err('Key missing, invalid, revoked or expired (code: api_key_required | invalid_api_key | api_key_revoked | api_key_expired)'),
  403: err('No permission (code: insufficient_scope | api_disabled | api_key_space_restricted | permission_denied | …). `permission_denied` means the user lacks a space permission (see `permissions` in /me); `params.permission` names it.'),
  429: err('Too many requests (code: rate_limited), see Retry-After'),
}
const q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema })
const spaceQ = q('space', "Space (id or name). Default: the key's space, otherwise the personal space. A key with a fixed space accepts only that space (otherwise 403, code: api_key_space_restricted).")

export function openapiDocument(baseUrl, rateLimit = 60) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Wishy API',
      version: '1.0.0',
      description:
        `Public API for Wishy. Authentication with an API key (Settings › API keys): header \`Authorization: Bearer <key>\` or \`X-API-Key\`. Limit: ${rateLimit} requests per minute and key. A key that was bound to a space on creation (\`space_id\`) works exclusively in that space: other spaces and the account-wide wishlists (\`/wishlists…\`, capture with \`kind: wish\`) respond with 403 (\`api_key_space_restricted\`); without a fixed space the key applies to all of the user's spaces. Errors: \`{ "error": "<text>", "code": "<stable_code>" }\`.`,
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ bearerAuth: [] }],
    tags: [{ name: 'Capture' }, { name: 'Read' }, { name: 'Wishlists' }],
    paths: {
      '/me': {
        get: { tags: ['Read'], summary: 'User, spaces and features of the key', operationId: 'getMe', responses: { 200: json(ref('Me')), ...common } },
      },
      '/capture': {
        post: {
          tags: ['Capture'],
          summary: 'Send clipboard: capture a link or text as an idea/wish',
          description:
            'With `url` (or text that is only a link) the link is imported (AI-assisted, if allowed). Free text is - if AI is allowed - split into one or more entries, otherwise an idea is created with the first line as its title. Ideas without a recognized person land in the inbox. The body may also be `text/plain` (whole body = text, e.g. for iOS Shortcuts). Requires the `write` permission.',
          operationId: 'capture',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('CaptureRequest') },
              'text/plain': { schema: { type: 'string', maxLength: 20000 }, example: 'Teapot for Anna, green' },
              'application/x-www-form-urlencoded': { schema: ref('CaptureRequest') },
            },
          },
          responses: { 201: json(ref('CaptureResponse'), 'Created'), 400: err('Invalid request (text_or_url_required, invalid_kind, self_idea, …)'), 403: err('No permission. Ideas need the space permission `manage_gifts`: code `permission_denied`, `params.permission` = `manage_gifts` (also insufficient_scope | api_key_space_restricted | …)'), 404: err('Space/wishlist not found'), ...common },
        },
      },
      '/persons': { get: { tags: ['Read'], summary: 'People in a space', operationId: 'listPersons', parameters: [spaceQ], responses: { 200: json(arr(ref('Person'))), ...common } } },
      '/ideas': {
        get: {
          tags: ['Read'],
          summary: 'Ideas (including inbox); ideas for yourself stay hidden',
          operationId: 'listIdeas',
          parameters: [q('person', 'Person (id or name) or "inbox" for the inbox'), spaceQ],
          responses: { 200: json(arr(ref('Idea'))), 404: err('Person not found'), ...common },
        },
        post: {
          tags: ['Capture'],
          summary: 'Create an idea (without a person: inbox)',
          operationId: 'createIdea',
          requestBody: { required: true, content: { 'application/json': { schema: ref('IdeaInput') } } },
          responses: { 201: json(ref('Idea'), 'Created'), 400: err('Invalid request'), 403: err('No permission. Needs the space permission `manage_gifts`: code `permission_denied`, `params.permission` = `manage_gifts` (also insufficient_scope | api_key_space_restricted | …)'), 404: err('Person/space not found'), ...common },
        },
      },
      '/wishlists': { get: { tags: ['Wishlists'], summary: 'Your own and shared wishlists', operationId: 'listWishlists', responses: { 200: json(arr(ref('WishlistSummary'))), ...common } } },
      '/wishlists/{id}': {
        get: {
          tags: ['Wishlists'],
          summary: 'Wishlist with wishes',
          operationId: 'getWishlist',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: json(ref('Wishlist')), 404: err('Nicht gefunden'), ...common },
        },
      },
      '/wishlists/{id}/wishes': {
        post: {
          tags: ['Wishlists'],
          summary: 'Add a wish to one of your own wishlists',
          operationId: 'createWish',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: { required: true, content: { 'application/json': { schema: ref('WishInput') } } },
          responses: { 201: json(ref('Wish'), 'Created'), 400: err('Invalid request'), 404: err('Wishlist not found'), ...common },
        },
      },
      '/occasions': {
        get: {
          tags: ['Read'],
          summary: 'Occasions',
          description: 'Without the space permission `view_expenses` the `budget` is null.',
          operationId: 'listOccasions',
          parameters: [q('upcoming', '1 = upcoming occasions only', { type: 'string', enum: ['0', '1'] }), spaceQ],
          responses: { 200: json(arr(ref('Occasion'))), ...common },
        },
      },
      '/gifts': {
        get: {
          tags: ['Read'],
          summary: 'Gifts (excluding gifts for yourself)',
          description: 'Without the space permission `view_expenses` the `price` is null.',
          operationId: 'listGifts',
          parameters: [q('status', 'Status', { type: 'string', enum: ['planned', 'ordered', 'shipped', 'delivered', 'wrapped', 'given', 'returned'] }), spaceQ],
          responses: { 200: json(arr(ref('Gift'))), 400: err('Invalid status'), ...common },
        },
      },
      '/openapi.json': { get: { tags: ['Read'], summary: 'This description (public)', operationId: 'getOpenApi', security: [], responses: { 200: { description: 'OpenAPI 3.1 document' } } } },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key (wishy_…)' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: {
        Error: { type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string' } } },
        Me: {
          type: 'object',
          properties: {
            user: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' } } },
            spaces: arr({ type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, personal: { type: 'boolean' }, role: { type: 'string' }, permissions: { type: 'object', description: 'Effective space permissions of the user (the owner has all)', properties: Object.fromEntries(['invite_members', 'share_wishlists', 'manage_persons', 'manage_occasions', 'manage_gifts', 'view_expenses', 'manage_space_settings'].map((k) => [k, { type: 'boolean' }])) } } }),
            default_space_id: { type: ['integer', 'null'] },
            features: { type: 'object', properties: { ai: { type: 'boolean' }, api: { type: 'boolean' } } },
            key: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, prefix: { type: 'string' }, scopes: arr({ type: 'string', enum: ['read', 'write'] }), space_id: { type: ['integer', 'null'] }, expires_at: { type: ['string', 'null'] } } },
          },
        },
        CaptureRequest: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 20000 },
            url: { type: 'string', format: 'uri' },
            kind: { type: 'string', enum: ['idea', 'wish'], default: 'idea' },
            person: { type: ['string', 'integer'], description: 'Name or id; unknown = inbox' },
            wishlist: { type: ['string', 'integer'], description: 'For wishes; default: first list' },
            space: { type: ['string', 'integer'] },
            use_ai: { type: 'boolean', description: 'true = read with AI, false = built-in only. Omitted: texts use AI if allowed for the user; links follow the admin default for link imports (built-in parser or AI).' },
          },
        },
        CaptureResponse: {
          type: 'object',
          required: ['created', 'inbox'],
          properties: {
            created: arr({
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['idea', 'wish'] },
                id: { type: 'integer' },
                title: { type: 'string' },
                person: { type: ['string', 'null'] },
                person_id: { type: ['integer', 'null'] },
                url: { type: ['string', 'null'] },
                inbox: { type: 'boolean' },
                wishlist: { type: 'string' },
                wishlist_id: { type: 'integer' },
              },
            }),
            inbox: { type: 'integer', description: 'Number of ideas that landed in the inbox' },
            ai_used: { type: 'boolean' },
            unmatched_person: { type: 'string' },
            warnings: arr({ type: 'string' }),
          },
        },
        Person: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, birthday: { type: ['string', 'null'] }, relationship: { type: ['string', 'null'], description: 'Display name of the relationship type in your language (null = none)' }, relationship_type: { type: ['string', 'null'], description: "Key of the space's relationship type (managed by the space, e.g. partner, friend or custom_...)" }, archived: { type: 'boolean' }, is_me: { type: 'boolean' } } },
        Idea: {
          type: 'object',
          properties: {
            id: { type: 'integer' }, title: { type: 'string' }, notes: { type: ['string', 'null'] }, url: { type: ['string', 'null'] },
            price: { type: ['number', 'null'] }, currency: { type: ['string', 'null'] }, image_url: { type: ['string', 'null'] },
            priority: { type: 'integer' }, status: { type: 'string' }, mentioned: { type: 'boolean' },
            person_id: { type: ['integer', 'null'] }, person: { type: ['string', 'null'] }, occasion_id: { type: ['integer', 'null'] },
            inbox: { type: 'boolean' }, created_at: { type: 'string' },
          },
        },
        IdeaInput: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', maxLength: 300 }, notes: { type: 'string' }, url: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' },
            person: { type: ['string', 'integer'] }, occasion_id: { type: 'integer' }, mentioned: { type: 'boolean' }, space: { type: ['string', 'integer'] },
          },
        },
        WishlistSummary: {
          type: 'object',
          properties: {
            id: { type: 'integer' }, title: { type: 'string' }, description: { type: ['string', 'null'] }, event_date: { type: ['string', 'null'] },
            archived: { type: 'boolean' }, owned: { type: 'boolean' }, owner: { type: ['string', 'null'] }, wish_count: { type: 'integer' }, open_count: { type: 'integer' },
          },
        },
        Wishlist: {
          type: 'object',
          properties: {
            id: { type: 'integer' }, title: { type: 'string' }, description: { type: ['string', 'null'] }, event_date: { type: ['string', 'null'] },
            owned: { type: 'boolean' }, owner: { type: ['string', 'null'] }, wishes: arr(ref('Wish')),
          },
        },
        Wish: {
          type: 'object',
          properties: {
            id: { type: 'integer' }, title: { type: 'string' }, notes: { type: ['string', 'null'] }, url: { type: ['string', 'null'] }, price: { type: ['number', 'null'] },
            currency: { type: ['string', 'null'] }, image_url: { type: ['string', 'null'] }, priority: { type: 'integer', minimum: 1, maximum: 3 },
            status: { type: 'string', enum: ['open', 'received', 'removed'] }, created_at: { type: 'string' },
            reserved: { type: 'boolean', description: "Only on other people's lists" }, reserved_by: { type: ['string', 'null'] }, reserved_by_me: { type: 'boolean' },
          },
        },
        WishInput: {
          type: 'object',
          required: ['title'],
          properties: { title: { type: 'string', maxLength: 300 }, notes: { type: 'string' }, url: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 3 } },
        },
        Occasion: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, type: { type: 'string', description: 'Key of the occasion type of the space (built-in such as birthday/christmas/other, or custom_*)' }, type_name: { type: 'string', description: "Display name of the type (custom or renamed name; otherwise the built-in name in the user's language)" }, date: { type: 'string', format: 'date' }, recurring: { type: 'boolean' }, audience: { type: 'string', enum: ['all', 'selected'], description: "'all' = every active person takes part (except the left out ones), 'selected' = only the listed persons" }, person_ids: arr({ type: 'integer', description: 'Effective participants' }), excluded_ids: arr({ type: 'integer', description: 'Persons left out of this occasion' }), budget: { type: ['number', 'null'] } } },
        Gift: {
          type: 'object',
          properties: {
            id: { type: 'integer' }, title: { type: 'string' }, status: { type: 'string' }, price: { type: ['number', 'null'] }, url: { type: ['string', 'null'] }, shop: { type: ['string', 'null'] },
            occasion_id: { type: ['integer', 'null'] }, date: { type: ['string', 'null'] }, recipient_ids: arr({ type: 'integer' }), payment_status: { type: 'string' },
            tracking_url: { type: ['string', 'null'] }, expected_at: { type: ['string', 'null'] },
          },
        },
      },
    },
  }
}
