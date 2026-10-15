import { describe, expect, it } from "vitest";
import { isActivePath, SECTIONS, TABS, TAB_ICONS } from "./nav";

describe("nav model", () => {
  it("offers the six bottom tabs with unique hrefs", () => {
    expect(TABS).toHaveLength(6);
    const hrefs = TABS.map((tab) => tab.href);
    expect(new Set(hrefs).size).toBe(6);
  });

  it("marks Home as an exact-match route", () => {
    const home = TABS.find((tab) => tab.label === "Home");
    expect(home).toEqual({ label: "Home", href: "/", end: true });
    // Only the dashboard root is exact-match.
    expect(TABS.filter((tab) => tab.end === true)).toHaveLength(1);
  });

  it("keeps the documented four-tab core: Workout, History, Exercises, Body", () => {
    const hrefs = TABS.map((tab) => tab.href);
    for (const href of ["/workout", "/history", "/exercises", "/body"]) {
      expect(hrefs, `missing tab for ${href}`).toContain(href);
    }
  });

  it("maps an icon for every tab label", () => {
    for (const tab of TABS) {
      expect(TAB_ICONS[tab.label], `missing icon for ${tab.label}`).toBeDefined();
    }
    expect(Object.keys(TAB_ICONS)).toHaveLength(TABS.length);
  });

  it("desktop sections are the tabs plus Activities", () => {
    expect(SECTIONS).toHaveLength(7);
    const sectionHrefs = SECTIONS.map((section) => section.href);
    for (const tab of TABS) {
      expect(sectionHrefs).toContain(tab.href);
    }
    expect(sectionHrefs).toContain("/activities");
    // Activities is a section but never a bottom tab.
    expect(TABS.map((tab) => tab.href)).not.toContain("/activities");
  });
});

describe("isActivePath", () => {
  const social = { label: "Social", href: "/social" };
  const home = { label: "Home", href: "/", end: true };

  it("matches a section by prefix so subpages count as current", () => {
    expect(isActivePath(social, "/social")).toBe(true);
    expect(isActivePath(social, "/social/heatmap")).toBe(true);
    expect(isActivePath(social, "/socialx")).toBe(false);
    expect(isActivePath(social, "/workout")).toBe(false);
  });

  it("keeps end items exact", () => {
    expect(isActivePath(home, "/")).toBe(true);
    expect(isActivePath(home, "/workout")).toBe(false);
  });
});
