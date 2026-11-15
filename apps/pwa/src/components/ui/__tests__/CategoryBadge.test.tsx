import { render, screen } from "@/lib/test-utils";
import { CategoryBadge } from "../CategoryBadge";

describe("CategoryBadge", () => {
  it("renders a Lucide icon for a known icon name", () => {
    const { container } = render(<CategoryBadge name="Food" icon="Coffee" />);
    expect(container.querySelector("[data-testid='category-badge'] svg")).toBeInTheDocument();
  });

  it.each([undefined, null, "", "NotAnIcon"])("falls back to the initial for icon %s", (icon) => {
    render(<CategoryBadge name="Food" icon={icon} />);
    expect(screen.getByTestId("category-badge")).toHaveTextContent("F");
    expect(screen.getByTestId("category-badge").querySelector("svg")).not.toBeInTheDocument();
  });
});
