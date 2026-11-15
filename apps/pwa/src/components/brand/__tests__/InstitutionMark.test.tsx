import { render, screen } from "@/lib/test-utils";
import { INSTITUTIONS } from "@/lib/institutions/catalog";
import { CardArtwork } from "../CardArtwork";
import { InstitutionMark } from "../InstitutionMark";

const nubank = INSTITUTIONS.find((institution) => institution.id === "nubank")!;

describe("inline brand SVG accessibility", () => {
  it("keeps InstitutionMark named and strips the SVG title", () => {
    const { container } = render(<InstitutionMark institution={nubank} />);

    expect(screen.getByRole("img", { name: "Nubank" })).toBeInTheDocument();
    expect(container.querySelector("title")).not.toBeInTheDocument();
  });

  it("strips the network SVG title inside CardArtwork", () => {
    const { container } = render(
      <CardArtwork institution={nubank} network="mastercard" />,
    );

    expect(container.querySelector("title")).not.toBeInTheDocument();
  });
});
