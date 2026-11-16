import { describe, expect, it } from "vitest";
import { correspondingLine } from "../model/correspondingLine";

describe("correspondingLine", () => {
  it("keeps the line when both texts are the same", () => {
    expect(correspondingLine("a\nb\nc\n", "a\nb\nc\n", 2)).toBe(2);
  });

  it("follows the line past lines added and removed above it", () => {
    const committed = "a\nb\nc\nd\n";
    const working = "new 1\nnew 2\na\nc\nd\n";

    expect(correspondingLine(committed, working, 3)).toBe(4);
  });

  it("goes to where a line removed from the other text was, the start of what replaced it", () => {
    expect(correspondingLine("a\nold\nc\n", "a\nnew 1\nnew 2\nc\n", 1)).toBe(1);
    expect(correspondingLine("a\ngone\nc\n", "a\nc\n", 1)).toBe(1);
  });

  it("stays within the other text when the line lies past its end", () => {
    expect(correspondingLine("a\nb\nc\nd", "a\nb", 3)).toBe(1);
    expect(correspondingLine("a\nb", "a\nb", 7)).toBe(1);
  });

  it("matches lines whose endings differ between the texts", () => {
    expect(correspondingLine("x\na\nb\n", "a\r\nb\r\n", 2)).toBe(1);
  });
});
