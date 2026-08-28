import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadComposer } from "./ThreadComposer";

describe("ThreadComposer", () => {
  it("names the line it will comment on", () => {
    render(<ThreadComposer filePath="src/a.ts" line={12} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("composer-target")).toHaveTextContent("src/a.ts:12");
  });

  it("will not submit an empty or whitespace-only comment", async () => {
    const onSubmit = vi.fn();
    render(<ThreadComposer filePath="src/a.ts" line={12} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const button = screen.getByRole("button", { name: /comment/iu });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox"), "   ");
    expect(button).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the trimmed body and clears itself", async () => {
    const onSubmit = vi.fn();
    render(<ThreadComposer filePath="src/a.ts" line={12} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox"), "  this double-counts  ");
    await userEvent.click(screen.getByRole("button", { name: /comment/iu }));
    expect(onSubmit).toHaveBeenCalledWith("this double-counts");
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("cancels without submitting", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<ThreadComposer filePath="src/a.ts" line={12} onSubmit={onSubmit} onCancel={onCancel} />);
    await userEvent.type(screen.getByRole("textbox"), "never mind");
    await userEvent.click(screen.getByRole("button", { name: /cancel/iu }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
