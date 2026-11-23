import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import { channels, type TillbaseApi } from "../shared/api";

let api: TillbaseApi;
beforeEach(() => {
  api = createHandlers(openDatabase(":memory:"), "T1", () => 1_000_000);
});

async function signInAs(name: string, role: "manager" | "cashier") {
  await api.createStaff({ name, pin: "2222", role });
  const u = (await api.loginUsers()).find((x) => x.name === name)!;
  await api.logout();
  await api.login(u.id, "2222");
}

describe("wiring", () => {
  it("every new method is in the channel list and has a handler", () => {
    for (const n of ["getBusinessProfile", "saveBusinessProfile", "beginOnboarding", "finishOnboarding", "restartOnboarding"]) {
      expect(channels).toContain(n);
      expect(typeof (api as unknown as Record<string, unknown>)[n]).toBe("function");
    }
  });
});

describe("first run", () => {
  it("creates the owner AND marks setup as started in one step; the owner is signed in", async () => {
    expect((await api.session()).needsSetup).toBe(true);
    const s = await api.beginOnboarding("Ayesha", "4821");
    expect(s.needsSetup).toBe(false);
    expect(s.user).toMatchObject({ name: "Ayesha", role: "owner" });
    expect(await api.getBusinessProfile()).toMatchObject({ status: "in_progress", step: 3 });
  });

  it("only works on a brand-new install, and a weak PIN creates nothing", async () => {
    await expect(api.beginOnboarding("Ayesha", "12")).rejects.toThrow(/PIN/);
    expect((await api.session()).needsSetup).toBe(true);
    expect(await api.loginUsers()).toHaveLength(0);
    await api.beginOnboarding("Ayesha", "4821");
    await expect(api.beginOnboarding("Eve", "9999")).rejects.toThrow(/already been completed/);
  });

  it("an existing install made the old way (setupOwner) is never sent through setup", async () => {
    await api.setupOwner("Boss", "1111");
    const p = await api.getBusinessProfile();
    expect(p.status).toBe("legacy");
    expect(p.modules).toHaveLength(7); // everything shown, as before
  });

  it("an interrupted setup survives closing the app: sign in again and the profile is still in progress", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "tb-onb-")), "x.sqlite");
    const db1 = openDatabase(file);
    const a1 = createHandlers(db1, "T1", () => 1);
    await a1.beginOnboarding("Ayesha", "4821");
    await a1.saveBusinessProfile({ country: "PK", type: "fastfood", step: 5 });
    await a1.updateSettings({ currency: "PKR" });
    db1.close();

    const a2 = createHandlers(openDatabase(file), "T1", () => 1);
    expect((await a2.session()).needsSetup).toBe(false); // goes to the sign-in screen, not a second setup
    const owner = (await a2.loginUsers())[0]!;
    await a2.login(owner.id, "4821");
    expect(await a2.getBusinessProfile()).toMatchObject({ status: "in_progress", step: 5, country: "PK", type: "fastfood" });
    expect((await a2.getSettings()).currency).toBe("PKR");
    expect((await a2.finishOnboarding()).status).toBe("complete");
  });
});

describe("saving answers and permissions", () => {
  it("the owner saves; staff can read the profile but not change it or restart setup", async () => {
    await api.beginOnboarding("Boss", "1111");
    await api.saveBusinessProfile({ type: "restaurant", country: "PK", timezone: "Asia/Karachi", dayCutoffHour: 3 });
    for (const role of ["manager", "cashier"] as const) {
      await signInAs(role === "manager" ? "Mo" : "Cy", role);
      expect((await api.getBusinessProfile()).type).toBe("restaurant");
      await expect(api.saveBusinessProfile({ type: "retail" })).rejects.toThrow(/permission/);
      await expect(api.finishOnboarding()).rejects.toThrow(/permission/);
      await expect(api.restartOnboarding()).rejects.toThrow(/permission/);
      await api.logout();
      const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
      await api.login(owner.id, "1111");
    }
    expect((await api.getBusinessProfile()).type).toBe("restaurant");
  });

  it("nobody signed in can read or change anything", async () => {
    await api.beginOnboarding("Boss", "1111");
    await api.logout();
    await expect(api.getBusinessProfile()).rejects.toThrow(/sign in/i);
    await expect(api.saveBusinessProfile({ type: "retail" })).rejects.toThrow(/sign in/i);
    await expect(api.finishOnboarding()).rejects.toThrow(/sign in/i);
  });

  it("restart keeps products, sales and settings, and bad answers are refused in plain words", async () => {
    await api.beginOnboarding("Boss", "1111");
    await api.createProduct({ name: "Tea", priceMinor: 5000, trackStock: false });
    await api.updateSettings({ storeName: "Chai Corner", currency: "PKR" });
    await api.saveBusinessProfile({ type: "retail", address: "Main Market" });
    await api.finishOnboarding();
    const again = await api.restartOnboarding();
    expect(again).toMatchObject({ status: "in_progress", type: "retail", address: "Main Market" });
    expect((await api.listProducts()).map((p) => p.name)).toEqual(["Tea"]);
    expect((await api.getSettings()).storeName).toBe("Chai Corner");
    await expect(api.saveBusinessProfile({ country: "ZZ" })).rejects.toThrow(/choose a country/i);
  });
});
