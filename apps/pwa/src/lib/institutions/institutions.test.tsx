import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/lib/test-utils";
import { InstitutionPicker } from "@/components/brand/InstitutionPicker";
import { InstitutionMark } from "@/components/brand/InstitutionMark";
import { CardArtwork } from "@/components/brand/CardArtwork";
import BankCard from "@/components/BankCard";
import { institutionSvg } from "@/components/brand/institution-svgs";
import {
  clearWorkspaceAppearance,
  readAppearance,
  writeAccountAppearance,
  resolveAccountPresentation,
} from "./appearance-store";
import { INSTITUTIONS, resolveInstitution, searchInstitutions } from "./catalog";

describe("institution identity", () => {
  it("resolves server presentation before saved appearance and heuristic", () => {
    const account = { id: "a", name: "Nubank", balanceCents: 0, kind: "credit_card" as const, institutionId: "itau", cardProductId: "nubank-roxinho" };
    expect(resolveAccountPresentation(account, { institutionId: "nubank", cardProductId: "nubank-ultravioleta" })).toMatchObject({
      institution: { id: "itau" },
      product: { id: "nubank-roxinho" },
    });
    expect(resolveAccountPresentation({ ...account, institutionId: null, cardProductId: null }, { institutionId: "itau", cardProductId: "nubank-roxinho" })).toMatchObject({
      institution: { id: "itau" },
      product: { id: "nubank-roxinho" },
    });
    expect(resolveAccountPresentation({ ...account, institutionId: null, cardProductId: null }, undefined)).toMatchObject({
      institution: { id: "nubank" },
    });
  });
  it("prioritizes popular exact matches and searches without accent sensitivity", () => {
    expect(searchInstitutions("NU")[0].id).toBe("nubank");
    expect(searchInstitutions("Itaú").some((institution) => institution.id === "itau")).toBe(true);
    expect(searchInstitutions("banco-do-brasil")[0].id).toBe("banco-do-brasil");
  });

  it("resolves ids, exact aliases, and legacy preset names accent-insensitively", () => {
    expect(resolveInstitution({ id: "nubank" })?.id).toBe("nubank");
    expect(resolveInstitution({ name: "ITAÚ" })?.id).toBe("itau");
    expect(resolveInstitution({ name: "Personnalite" })?.id).toBe("itau");
    expect(resolveInstitution({ name: "unlisted institution" })).toBeUndefined();
  });

  it("keeps vendored institution logo paths and inline SVG map keys in sync", () => {
    const catalogLogos = new Set(INSTITUTIONS.map((entry) => entry.logoSrc).filter(Boolean));
    for (const key of Object.keys(institutionSvg)) {
      expect(catalogLogos.has(key)).toBe(true);
    }
    for (const id of ["nubank", "mercado-pago", "pagseguro", "wise"]) {
      const institution = INSTITUTIONS.find((entry) => entry.id === id);
      expect(institution?.logoSrc).toBeDefined();
      expect(institutionSvg).toHaveProperty(institution!.logoSrc!);
    }
    for (const id of ["itau", "bradesco", "santander", "banco-do-brasil", "caixa", "inter", "c6-bank", "xp"]) {
      const institution = INSTITUTIONS.find((entry) => entry.id === id);
      expect(institution?.logoSrc).toBe(`/brands/institutions/${id}.svg`);
    }
  });

  it("isolates appearance by workspace and tolerates corrupt storage", () => {
    writeAccountAppearance("one", "account-a", { institutionId: "nubank" });
    expect(readAppearance("two")).toEqual({});
    localStorage.setItem("meu-ted:account-appearance:v1:bad", "{");
    expect(readAppearance("bad")).toEqual({});
    expect(readAppearance("one")["account-a"].institutionId).toBe("nubank");
    clearWorkspaceAppearance("one");
  });

  it("renders official logo images, two-character monograms, and neutral fallback", () => {
    const { container } = render(
      <>
        <InstitutionMark institution={searchInstitutions("itau")[0]} />
        <InstitutionMark institution={searchInstitutions("avenue")[0]} />
        <InstitutionMark institution={searchInstitutions("cooperforte")[0]} />
        <InstitutionMark />
      </>,
    );
    expect(container.querySelector('img[src="/brands/institutions/itau.svg"]')).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Avenue" })).toHaveTextContent("AV");
    expect(screen.getByRole("img", { name: "Cooperforte" })).toHaveTextContent("CO");
    expect(screen.getByRole("img", { name: "Instituição" })).toBeInTheDocument();
  });

  it("never fabricates card digits and renders proper chip/contactless SVGs", () => {
    render(<CardArtwork network="unknown" />);
    expect(screen.getByText("•••• •••• •••• ••••")).toBeInTheDocument();
    expect(screen.getByTestId("card-chip").tagName.toLowerCase()).toBe("svg");
    expect(screen.getByTestId("card-contactless").tagName.toLowerCase()).toBe("svg");
  });

  it("uses supplied product material instead of a legacy preset gradient", () => {
    const product = {
      id: "custom-product",
      institutionId: "nubank",
      name: "Metal test",
      network: "visa" as const,
      material: "metal" as const,
      colors: { base: "#222222", accent: "#D8C18A", text: "#fff" },
      artSource: "illustrative" as const,
    };
    const { getByTestId } = render(<BankCard bankId="nubank" product={product} cardName="Metal test" />);
    expect(getByTestId("bank-card").style.background).toContain("rgb(216, 193, 138)");
  });

  it("selects a picker option with keyboard", () => {
    const onSelect = vi.fn();
    const onManual = vi.fn();
    render(<InstitutionPicker onSelect={onSelect} onManual={onManual} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "nubank" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "nubank" }));
  });

  it("hides empty manual entry and commits non-empty manual text with Enter", () => {
    const onSelect = vi.fn();
    const onManual = vi.fn();
    render(<InstitutionPicker onSelect={onSelect} onManual={onManual} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(screen.queryByText(/Outra instituição/)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Banco novo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onManual).toHaveBeenCalledWith("Banco novo");
  });

  it("reflects selected-value changes from its caller", () => {
    const onSelect = vi.fn();
    const onManual = vi.fn();
    const { rerender } = render(
      <InstitutionPicker
        value={INSTITUTIONS.find((institution) => institution.id === "inter")}
        onSelect={onSelect}
        onManual={onManual}
      />,
    );
    const input = screen.getByRole("combobox");
    expect(input).toHaveValue("Inter");
    rerender(
      <InstitutionPicker
        value={INSTITUTIONS.find((institution) => institution.id === "caixa")}
        onSelect={onSelect}
        onManual={onManual}
      />,
    );
    expect(screen.getByRole("combobox")).toHaveValue("Caixa");
  });
});
