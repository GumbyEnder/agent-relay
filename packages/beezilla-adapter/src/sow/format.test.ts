/**
 * BeeZilla — SOW formatter tests
 *
 * Tests:
 * 1. fillTemplate replaces all {{PLACEHOLDER}} tokens
 * 2. toMarkdown produces the same markdown string
 * 3. toPdf produces a valid PDF header
 * 4. Dana fixture answers appear in markdown
 * 5. Empty answers are handled gracefully
 */

import { describe, it, expect } from "vitest";
import { fillTemplate, toMarkdown, toPdf, fromInterview } from "./format.js";
import type { SowAnswers } from "./format.js";

// ---------------------------------------------------------------------------
// Dana fixture answers
// ---------------------------------------------------------------------------

const danaAnswers: SowAnswers = {
  clientName: "Dana",
  propertyAddress: "123 Oak Street",
  date: "2026-09-17",
  whatTheyWant: "Replace broken fence panels",
  whyNow: "Storm damage left sections unsafe",
  propertyDetails: "Large backyard, gentle slope",
  householdDetails: "Two kids, one dog",
  stylePreference: "Wood privacy fence",
  heightAndLook: "6 feet tall, natural wood",
  gates: "Two gates — one 4ft walk gate, one 10ft vehicle gate",
  timeline: "Wants it done before summer ends",
  budgetRange: "$3000-$5000",
  propertyLineNotes: "Surveyed — stakes visible",
  groundConditions: "Clay soil, some rocks near east side",
  obstacles: "One mature oak tree, sprinkler head near south gate",
  utilityLocateStatus: "811 called — marked last Tuesday",
  existingFenceStatus: "Remove 30 feet of damaged cedar panels",
  photoReferences: "5 photos on file — front, back, side views",
  doneCriterion1: "All posts set plumb and at specified depth: 24 inches",
  doneCriterion2: "Panels installed per agreed style and height",
  doneCriterion3: "Gates installed, latch and swing tested",
  doneCriterion4: "All debris and old fencing hauled away",
  doneCriterion5: "Concrete footings cured, no exposed hardware hazards",
  walkthroughArrangement: "Client walk-through on completion day",
  exclusion1: "Landscaping repair after dig",
  exclusion2: "Property line survey — client to arrange",
  exclusion3: "Sprinkler/irrigation line repair",
  exclusion4: "Painting/staining",
  exclusion5: "Tree trimming around fence line",
  permitResponsibility: "Contractor to pull permit",
  item1: "Posts",
  item1Desc: "4x4 pressure-treated posts",
  item1Qty: "20",
  item1Unit: "$45.00",
  item1Total: "$900.00",
  item2: "Panels",
  item2Desc: "6ft cedar privacy panels",
  item2Qty: "30",
  item2Unit: "$35.00",
  item2Total: "$1050.00",
  item3: "Gates",
  item3Desc: "4ft walk gate with latch",
  item3Qty: "1",
  item3Unit: "$120.00",
  item3Total: "$120.00",
  haulDesc: "Old fence removal and haul-off",
  haulQty: "1",
  haulUnit: "$250.00",
  haulTotal: "$250.00",
  subtotal: "$2320.00",
  tax: "$185.60",
  total: "$2505.60",
  paymentTerms: "50% deposit, 50% on completion",
  estimatedStart: "Week of October 6",
  estimatedDuration: "2-3 days",
  postDepth: "24 inches",
};

// ---------------------------------------------------------------------------
// TEST 1: fillTemplate replaces all placeholders
// ---------------------------------------------------------------------------

describe("fillTemplate", () => {
  it("replaces all {{PLACEHOLDER}} tokens with answer values", () => {
    const result = fillTemplate(danaAnswers);

    // Check a few key replacements
    expect(result).toContain("Dana");
    expect(result).toContain("123 Oak Street");
    expect(result).toContain("Replace broken fence panels");
    expect(result).toContain("Storm damage left sections unsafe");
    expect(result).toContain("Wood privacy fence");
    expect(result).toContain("$2505.60");
    expect(result).toContain("50% deposit, 50% on completion");

    // No placeholders should remain
    expect(result).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("preserves template structure (headings, tables, checkboxes)", () => {
    const result = fillTemplate(danaAnswers);

    expect(result).toContain("## 1. What We Talked About (Interview Notes)");
    expect(result).toContain("## 4. What's NOT Included (Exclusions)");
    expect(result).toContain("## 5. The Quote");
    expect(result).toContain("## 6. Sign-off");
    expect(result).toContain("| Line item | Description | Qty | Unit price | Total |");
    expect(result).toContain("- [ ]");
  });

  it("handles empty string answers gracefully", () => {
    const emptyAnswers: SowAnswers = {
      clientName: "",
      propertyAddress: "",
      date: "",
      whatTheyWant: "",
      whyNow: "",
      propertyDetails: "",
      householdDetails: "",
      stylePreference: "",
      heightAndLook: "",
      gates: "",
      timeline: "",
      budgetRange: "",
      propertyLineNotes: "",
      groundConditions: "",
      obstacles: "",
      utilityLocateStatus: "",
      existingFenceStatus: "",
      photoReferences: "",
      doneCriterion1: "",
      doneCriterion2: "",
      doneCriterion3: "",
      doneCriterion4: "",
      doneCriterion5: "",
      walkthroughArrangement: "",
      exclusion1: "",
      exclusion2: "",
      exclusion3: "",
      exclusion4: "",
      exclusion5: "",
      permitResponsibility: "",
      item1: "",
      item1Desc: "",
      item1Qty: "",
      item1Unit: "",
      item1Total: "",
      item2: "",
      item2Desc: "",
      item2Qty: "",
      item2Unit: "",
      item2Total: "",
      item3: "",
      item3Desc: "",
      item3Qty: "",
      item3Unit: "",
      item3Total: "",
      haulDesc: "",
      haulQty: "",
      haulUnit: "",
      haulTotal: "",
      subtotal: "",
      tax: "",
      total: "",
      paymentTerms: "",
      estimatedStart: "",
      estimatedDuration: "",
      postDepth: "",
    };

    const result = fillTemplate(emptyAnswers);

    // Should still be valid markdown structure
    expect(result).toContain("## 1. What We Talked About (Interview Notes)");
    expect(result).toContain("## 6. Sign-off");

    // Placeholders should be replaced with empty strings (no {{...}} left)
    expect(result).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

// ---------------------------------------------------------------------------
// TEST 2: toMarkdown produces the same markdown string
// ---------------------------------------------------------------------------

describe("toMarkdown", () => {
  it("produces the same output as fillTemplate", () => {
    const markdown = toMarkdown(danaAnswers);
    const filled = fillTemplate(danaAnswers);

    expect(markdown).toBe(filled);
  });

  it("returns a markdown string with Dana fixture data", () => {
    const markdown = toMarkdown(danaAnswers);

    // Key Dana-specific content should appear
    expect(markdown).toContain("Dana (homeowner)");
    expect(markdown).toContain("123 Oak Street");
    expect(markdown).toContain("Replace broken fence panels");
    expect(markdown).toContain("Two kids, one dog");
    expect(markdown).toContain("$900.00");
    expect(markdown).toContain("$1050.00");
    expect(markdown).toContain("$120.00");
    expect(markdown).toContain("$2320.00");
    expect(markdown).toContain("$185.60");
    expect(markdown).toContain("$2505.60");
  });
});

// ---------------------------------------------------------------------------
// TEST 3: toPdf produces a valid PDF header
// ---------------------------------------------------------------------------

describe("toPdf", () => {
  it("returns a Uint8Array", () => {
    const pdf = toPdf(danaAnswers);
    expect(pdf).toBeInstanceOf(Uint8Array);
  });

  it("PDF starts with %PDF header", () => {
    const pdf = toPdf(danaAnswers);
    const header = new TextDecoder().decode(pdf.slice(0, 8));
    expect(header).toBe("%PDF-1.4");
  });

  it("PDF contains trailer and endxref markers", () => {
    const pdf = toPdf(danaAnswers);
    const text = new TextDecoder().decode(pdf);

    expect(text).toContain("trailer");
    expect(text).toContain("startxref");
    expect(text).toContain("%%EOF");
  });

  it("PDF contains xref table", () => {
    const pdf = toPdf(danaAnswers);
    const text = new TextDecoder().decode(pdf);

    expect(text).toContain("xref");
  });

  it("PDF contains content stream with text", () => {
    const pdf = toPdf(danaAnswers);
    const text = new TextDecoder().decode(pdf);

    // Should contain PDF text rendering operators
    expect(text).toContain("BT");
    expect(text).toContain("Tj");
    expect(text).toContain("ET");
  });

  it("Dana fixture answers appear in PDF text", () => {
    const pdf = toPdf(danaAnswers);
    const text = new TextDecoder().decode(pdf);

    // Key content should be in the PDF stream
    expect(text).toContain("Dana");
    expect(text).toContain("123 Oak Street");
    expect(text).toContain("Replace broken fence panels");
    expect(text).toContain("$2505.60");
  });

  it("PDF is non-empty and has reasonable size", () => {
    const pdf = toPdf(danaAnswers);
    // A minimal PDF with Dana's content should be at least 1KB
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// TEST 6: fromInterview maps interview answers → SowAnswers → markdown
// ---------------------------------------------------------------------------

describe("fromInterview", () => {
  it("maps interview ids into SowAnswers correctly", () => {
    const interviewAnswers: Record<string, string> = {
      what_happened: "Storm knocked down the north section",
      rough_size: "About 60 feet of fence along the back yard",
      material_supplier: "Contractor supplies",
      budget_range: "$2000-$4000",
      timing: "Need it done by October",
      done_right_check: "Fence straight\nGates latch properly\nNo gaps between panels",
      quote_count: "Comparing quotes — itemized",
      exclusions: "No tree trimming\nNo landscaping repair",
      property_address: "456 Maple Drive",
    };

    const answers = fromInterview(interviewAnswers);

    // Check key mappings
    expect(answers.clientName).toBe("Dana");
    expect(answers.propertyAddress).toBe("456 Maple Drive");
    expect(answers.whatTheyWant).toBe("Storm knocked down the north section");
    expect(answers.propertyDetails).toBe("About 60 feet of fence along the back yard");
    expect(answers.timeline).toBe("Need it done by October");
    expect(answers.budgetRange).toBe("$2000-$4000");
    expect(answers.postDepth).toBe("24 inches");
  });

  it("uses defaults when interview answers are missing", () => {
    const interviewAnswers: Record<string, string> = {
      what_happened: "Storm knocked down the north section",
    };

    const defaults: Record<string, string> = {
      what_happened: "Storm damage, full fence line affected.",
      rough_size: "Typical residential yard, single line.",
      timing: "Flexible timing.",
      done_right_check: "Fence straight, panels secure, gates work.",
      exclusions: "No exclusions.",
      budget_range: "No stated budget — quotes will define it.",
    };

    const answers = fromInterview(interviewAnswers, defaults);

    // Provided answer wins
    expect(answers.whatTheyWant).toBe("Storm knocked down the north section");
    // Defaults fill in
    expect(answers.propertyDetails).toBe("Typical residential yard, single line.");
    expect(answers.timeline).toBe("Flexible timing.");
    expect(answers.budgetRange).toBe("No stated budget — quotes will define it.");
  });

  it("Dana fixture through fromInterview → toMarkdown contains fence/storm/defaults", () => {
    // Simulate a Dana interview with realistic answers
    const interviewAnswers: Record<string, string> = {
      what_happened: "Storm knocked down the north section of the fence",
      rough_size: "About 80 feet along the back and side yard",
      material_supplier: "Contractor supplies",
      budget_range: "$3000-$5000",
      timing: "Need it done by Halloween",
      done_right_check: "Fence straight and secure\nGates work properly\nClean job site",
      quote_count: "Comparing quotes — itemized",
      exclusions: "No tree trimming needed",
    };

    const answers = fromInterview(interviewAnswers);
    const markdown = toMarkdown(answers);

    // Should contain storm reference from what_happened
    expect(markdown).toContain("Storm");
    expect(markdown).toContain("north section");

    // Should contain fence references
    expect(markdown).toContain("fence");
    expect(markdown).toContain("80 feet");

    // Should contain defaults where no interview answer was provided
    expect(markdown).toContain("24 inches"); // default post depth
    expect(markdown).toContain("Dana"); // default client name

    // Should NOT contain placeholders
    expect(markdown).not.toMatch(/\{\{[A-Z_]+\}\}/);

    // Done criteria should be split from multi-line answer
    expect(markdown).toContain("Fence straight and secure");
    expect(markdown).toContain("Gates work properly");
    expect(markdown).toContain("Clean job site");

    // Exclusions should be split
    expect(markdown).toContain("No tree trimming needed");
  });

  it("handles empty interview answers gracefully", () => {
    const answers = fromInterview({});
    const markdown = toMarkdown(answers);

    // Should still be valid structure
    expect(markdown).toContain("## 1. What We Talked About (Interview Notes)");
    expect(markdown).toContain("## 6. Sign-off");

    // Placeholders should be replaced
    expect(markdown).not.toMatch(/\{\{[A-Z_]+\}\}/);

    // Should have defaults
    expect(markdown).toContain("Dana");
    expect(markdown).toContain("24 inches");
  });
});
