import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";

describe("regressões do incidente", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedIncident(db);
    app = createApp(db);
  });

  afterEach(() => {
    db.close();
  });

  function postJson(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each([
    ["2026-03-13T02:59:59.999Z", 201],
    ["2026-03-12T23:59:59.999-03:00", 201],
    ["2026-03-13T04:59:59.999+02:00", 201],
    ["2026-03-13T03:00:00.000Z", 409],
    ["2026-03-12T23:00:00.000-05:00", 409],
  ])("avalia o prazo pelo instante em São Paulo: %s", async (approvedAt, status) => {
    const response = await postJson("/approvals", {
      mission_id: "msn_1842",
      approved_at: approvedAt,
      idempotency_key: "pay_boundary",
    });

    expect(response.status).toBe(status);
    const mission = await app.request("/missions/msn_1842");
    const body = (await mission.json()) as { ledger: unknown[]; payout: unknown };
    expect(body.ledger).toHaveLength(status === 201 ? 1 : 0);
    if (status === 409) expect(body.payout).toBeNull();
  });

  it.each(["pay_7c1\u200B", " \u200BPAY_7C1\u200B \t"])(
    "reutiliza o crédito e o repasse no retry com chave %j",
    async (retryKey) => {
      const payload = {
        mission_id: "msn_2044",
        approved_at: "2026-03-12T21:05:00.000Z",
        idempotency_key: "pay_7c1",
      };
      const first = await postJson("/approvals", payload);
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as {
        ledger: { amount_brl: number };
        payout: { id: string };
      };
      const retry = await postJson("/approvals", { ...payload, idempotency_key: retryKey });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual(firstBody);
      const mission = await app.request("/missions/msn_2044");
      const body = (await mission.json()) as { ledger: unknown[]; payout: { id: string } };
      expect(body.ledger).toHaveLength(1);
      expect(body.payout.id).toBe(firstBody.payout.id);
      expect(firstBody.ledger.amount_brl).toBe(80);
    },
  );

  it("preserva os centavos no valor gravado em reais", async () => {
    db.prepare("UPDATE missions SET amount_cents = ? WHERE id = ?").run(15001, "msn_1900");
    const response = await postJson("/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_cents",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { ledger: { amount_brl: number } };
    expect(body.ledger.amount_brl).toBe(150.01);
  });

  it("confirma o repasse sem criar outro crédito no callback repetido", async () => {
    const response = await postJson("/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_confirmed",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { payout: { id: string } };
    const path = `/payouts/${body.payout.id}/provider`;

    for (const providerStatus of ["PENDING", "CONFIRMED", "CONFIRMED"]) {
      const callback = await postJson(path, { provider_status: providerStatus });
      expect(callback.status).toBe(200);
      expect(await callback.json()).toMatchObject({
        provider_status: providerStatus,
        status: providerStatus === "PENDING" ? "pending" : "paid",
      });
    }

    const mission = await app.request("/missions/msn_2044");
    const result = (await mission.json()) as {
      ledger: unknown[];
      payout: { provider_status: string; status: string };
    };
    expect(result.ledger).toHaveLength(1);
    expect(result.payout).toMatchObject({ provider_status: "CONFIRMED", status: "paid" });
  });
});
