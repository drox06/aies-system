import { describe, expect, it } from "vitest";
import { formatAddress } from "@/lib/address";

/**
 * Addresses are stored as `Json` deliberately (prisma/schema/crm.prisma), which leaves this function
 * to decide what the block reads as. The delivery note, the PDF header and a driver's navigation
 * link all go through here so they cannot disagree about the same site.
 */

describe("formatAddress", () => {
  it("emits Philippine postal order regardless of how the object was written", () => {
    const written = { city: "Makati", street: "12 Rizal Ave", barangay: "Poblacion" };
    // Key order in the record is an accident of how it was saved; the output must not inherit it.
    expect(formatAddress(written)).toBe("12 Rizal Ave, Poblacion, Makati");
    expect(formatAddress({ barangay: "Poblacion", city: "Makati", street: "12 Rizal Ave" })).toBe(
      "12 Rizal Ave, Poblacion, Makati",
    );
  });

  it("keeps a field it has never heard of rather than dropping it", () => {
    const result = formatAddress({ street: "12 Rizal Ave", landmark: "beside the covered court" });
    expect(result).toBe("12 Rizal Ave, beside the covered court");
  });

  it("leaves coordinates and notes out of a postal address", () => {
    expect(formatAddress({ city: "Cebu", lat: 10.3, lng: 123.9, notes: "call first" })).toBe(
      "Cebu",
    );
  });

  it("says nothing rather than something empty", () => {
    expect(formatAddress({})).toBeNull();
    expect(formatAddress(null)).toBeNull();
    expect(formatAddress({ city: "   " })).toBeNull();
  });

  it("passes a plain string through", () => {
    expect(formatAddress("Unit 4, Bonifacio Global City")).toBe("Unit 4, Bonifacio Global City");
  });
});
