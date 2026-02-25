# Adapters — Third-Party SDK Wrappers

Wrap every external SDK in a thin adapter. Import the adapter in your
source code, not the SDK directly. In tests, mock the adapter module.

## Pattern (works in any language)

```typescript
// src/adapters/twilio.ts — thin wrapper
import twilio from 'twilio';

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

export async function sendSms(to: string, body: string): Promise<string> {
  const msg = await client.messages.create({
    to,
    from: process.env.TWILIO_FROM!,
    body,
  });
  return msg.sid;
}
```

```typescript
// src/services/notification.ts — uses the adapter
import { sendSms } from '../adapters/twilio.js';

export async function notifyUser(phone: string, text: string) {
  return sendSms(phone, text);
}
```

```typescript
// tests/services/notification.test.ts — mocks the adapter
import { vi } from 'vitest';
vi.mock('../src/adapters/twilio.js', () => ({
  sendSms: vi.fn().mockResolvedValue('SM123'),
}));
```

## Why

- Direct SDK mocks fail due to module system issues (ESM, CJS interop)
- Adapter mocks are reliable because you control the module
- Same pattern in Python (`unittest.mock.patch`), Go (interfaces), Rust (traits)
