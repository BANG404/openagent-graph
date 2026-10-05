import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { errorNotice, requestLocale, resolveLocale } from "../bin/i18n.mjs";

const i18n = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")).extensions.openagent.i18n;

test("Graph translations cover every declared host label and notice", () => {
  expect(i18n.supported_locales).toEqual(["en", "zh"]);
  const baseline = Object.keys(i18n.translations.en).sort();
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const locale of i18n.supported_locales) {
    expect(Object.keys(i18n.translations[locale]).sort()).toEqual(baseline);
    for (const key of baseline) {
      expect(i18n.translations[locale][key].trim()).not.toBe("");
      expect(placeholders(i18n.translations[locale][key])).toEqual(placeholders(i18n.translations.en[key]));
    }
  }
});

test("Graph uses the per-call locale and keeps node identifiers unchanged", async () => {
  let reads = 0;
  const host = { locale: { get: async () => { reads += 1; return "zh"; } } };
  expect(resolveLocale("zh-TW")).toBe("zh");
  expect(await requestLocale({}, host)).toBe("zh");
  expect(await requestLocale({ _openagent: { locale: "en" } }, host)).toBe("en");
  expect(reads).toBe(1);
  expect(errorNotice(new Error("Graph node 'research' ended with final_failed"), "zh"))
    .toBe("图节点“research”已以 final_failed 状态结束");
});
