import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() });
  return { webhookEndpoint: model(), webhookDelivery: model(), platformSetting: model(), tenant: model(), membership: model() };
});
const queued = vi.hoisted(() => ({ queueEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/email", () => queued);

import { encrypt } from "@/lib/crypto/tokens";
import { DISABLE_AFTER_FAILURES, processDelivery } from "@/lib/integrations/deliver";
import { hostOf, notifyEndpointDisabled, webhookDisabledMail } from "@/lib/integrations/notify";

const publicResolver = async () => ["93.184.216.34"];
const failing = async () => ({ status: 500 });
const secret = encrypt("whsec");
const endpoint = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  tenantId: "t1",
  url: "https://hooks.example.com/in/secret-path?token=abc",
  enabled: true,
  failureCount: 0,
  secretCiphertext: secret.ciphertext,
  iv: secret.iv,
  authTag: secret.authTag,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.platformSetting.create.mockResolvedValue({});
  db.tenant.findUnique.mockResolvedValue({ name: "Acme" });
  db.membership.findMany.mockResolvedValue([{ user: { email: "owner@acme.test", name: "Olu" } }]);
  db.webhookDelivery.findFirst.mockResolvedValue({ id: "d1", endpointId: "e1", event: "message.received", payload: { id: "x" }, status: "pending", attempts: 5 });
  db.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
  db.webhookEndpoint.updateMany.mockResolvedValue({ count: 1 });
});

describe("the endpoint-disabled notice", () => {
  it("names only the host, never the path or token of the url", () => {
    expect(hostOf("https://hooks.example.com/in/secret-path?token=abc")).toBe("hooks.example.com");
    expect(hostOf("not a url")).toBe("your endpoint");
    const mail = webhookDisabledMail({ workspaceName: "Acme <b>", host: "hooks.example.com", failures: 20 });
    expect(mail.text).toContain("hooks.example.com");
    expect(mail.text).not.toContain("secret-path");
    expect(mail.html).toContain("Acme &lt;b&gt;");
    expect(mail.html).not.toContain("<b>");
  });

  it("emails the owners once a day per endpoint", async () => {
    const input = { tenantId: "t1", endpointId: "e1", url: "https://hooks.example.com/x", failures: 20 };
    expect(await notifyEndpointDisabled(input, Date.UTC(2026, 9, 27, 10))).toBe(1);
    // emailOwners queues strictly so a one-time marker can be given back when the queue refuses the mail.
    expect(queued.queueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@acme.test", subject: "A webhook endpoint was switched off" }), { strict: true });
    db.platformSetting.create.mockRejectedValueOnce(new Error("unique"));
    expect(await notifyEndpointDisabled(input, Date.UTC(2026, 9, 27, 18))).toBe(0);
    expect(queued.queueEmail).toHaveBeenCalledTimes(1);
  });

  it("never throws when mail cannot be queued", async () => {
    db.tenant.findUnique.mockRejectedValue(new Error("db down"));
    await expect(notifyEndpointDisabled({ tenantId: "t1", endpointId: "e1", url: "https://h.example", failures: 20 })).resolves.toBe(0);
  });
});

describe("processDelivery tells the owners when it switches an endpoint off", () => {
  const run = (_failureCount: number) => processDelivery({ deliveryId: "d1", tenantId: "t1" }, { isLastAttempt: true } as never, { resolve: publicResolver, transport: failing });

  it("at the failure that disables it", async () => {
    db.webhookEndpoint.findFirst.mockResolvedValue(endpoint({ failureCount: DISABLE_AFTER_FAILURES - 1 }));
    await run(DISABLE_AFTER_FAILURES);
    expect(db.webhookEndpoint.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { failureCount: DISABLE_AFTER_FAILURES, enabled: false } }));
    expect(queued.queueEmail).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(queued.queueEmail.mock.calls)).not.toContain("secret-path");
  });

  it("not before", async () => {
    db.webhookEndpoint.findFirst.mockResolvedValue(endpoint({ failureCount: 3 }));
    await run(4);
    expect(queued.queueEmail).not.toHaveBeenCalled();
  });
});
