import { rupees, dateOnly } from "../format";
import { Notice, useLoad } from "../ui";
import type { Invoice } from "../types";

// A GST tax invoice or credit note, laid out for A4 or an 80 mm counter printer (the page adapts).
// Opened at #invoice/<id>; the browser's print dialog does the rest.

function words(paise: number): string {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (n: number) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`);
  const three = (n: number) => `${n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? " " : ""}` : ""}${n % 100 ? two(n % 100) : ""}`;
  // Indian grouping: crore, lakh, thousand, hundred.
  const indian = (n: number): string => {
    if (n === 0) return "Zero";
    const parts: string[] = [];
    const crore = Math.floor(n / 10_000_000);
    const lakh = Math.floor((n % 10_000_000) / 100_000);
    const thousand = Math.floor((n % 100_000) / 1000);
    const rest = n % 1000;
    if (crore) parts.push(`${indian(crore)} Crore`);
    if (lakh) parts.push(`${two(lakh)} Lakh`);
    if (thousand) parts.push(`${two(thousand)} Thousand`);
    if (rest) parts.push(three(rest));
    return parts.join(" ");
  };
  const rupeesPart = Math.floor(paise / 100);
  const paisePart = paise % 100;
  return `Rupees ${indian(rupeesPart)}${paisePart ? ` and ${two(paisePart)} Paise` : ""} only`;
}

export function InvoicePrint({ id }: { id: string }) {
  const { data, error } = useLoad<{ invoice: Invoice }>(`/api/invoices/${id}`);
  const original = useLoad<{ invoice: Invoice }>(data?.invoice.againstInvoiceId ? `/api/invoices/${data.invoice.againstInvoiceId}` : null);
  if (error) return <Notice>{error}</Notice>;
  if (!data) return <div className="empty">Loading…</div>;
  const invoice = data.invoice;
  const credit = invoice.kind === "credit_note";

  return (
    <div className="invoice-page">
      <div className="no-print invoice-tools">
        <button className="btn primary" onClick={() => window.print()}>
          Print
        </button>
        <button className="btn" onClick={() => window.close()}>
          Close
        </button>
      </div>
      <article className="invoice">
        <header>
          <div>
            <h1>{invoice.seller.legalName || "—"}</h1>
            <div>{invoice.seller.address}</div>
            <div>GSTIN: {invoice.seller.gstin || "not set"}</div>
          </div>
          <div className="invoice-title">
            <h2>{credit ? "Credit note" : "Tax invoice"}</h2>
            <div>
              No. <strong>{invoice.number}</strong>
            </div>
            <div>Date {dateOnly(invoice.date)}</div>
            {credit && original.data && <div>Against invoice {original.data.invoice.number}</div>}
          </div>
        </header>

        <section className="invoice-parties">
          <div>
            <div className="label">Bill to</div>
            <div>{invoice.buyer.name || "Walk-in customer"}</div>
            {invoice.buyer.address && <div className="pre">{invoice.buyer.address}</div>}
          </div>
          <div>
            <div className="label">Place of supply</div>
            <div>
              {invoice.placeOfSupply.state} ({invoice.placeOfSupply.stateCode})
            </div>
          </div>
        </section>

        <table className="invoice-lines">
          <thead>
            <tr>
              <th>Item</th>
              <th>HSN</th>
              <th className="num">Qty</th>
              <th className="num">Rate</th>
              <th className="num">Taxable</th>
              <th className="num">GST</th>
              {invoice.interState ? <th className="num">IGST</th> : (
                <>
                  <th className="num">CGST</th>
                  <th className="num">SGST</th>
                </>
              )}
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line, index) => (
              <tr key={index}>
                <td>{line.description}</td>
                <td>{line.hsn}</td>
                <td className="num">{line.qty}</td>
                <td className="num">{rupees(line.unitPaise)}</td>
                <td className="num">{rupees(line.taxablePaise)}</td>
                <td className="num">{line.rate}%</td>
                {invoice.interState ? <td className="num">{rupees(line.igstPaise)}</td> : (
                  <>
                    <td className="num">{rupees(line.cgstPaise)}</td>
                    <td className="num">{rupees(line.sgstPaise)}</td>
                  </>
                )}
                <td className="num">{rupees(line.totalPaise)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Total</td>
              <td className="num">{rupees(invoice.totals.taxablePaise)}</td>
              <td />
              {invoice.interState ? <td className="num">{rupees(invoice.totals.igstPaise)}</td> : (
                <>
                  <td className="num">{rupees(invoice.totals.cgstPaise)}</td>
                  <td className="num">{rupees(invoice.totals.sgstPaise)}</td>
                </>
              )}
              <td className="num">
                <strong>{rupees(invoice.totals.totalPaise)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
        <p>
          <strong>{words(invoice.totals.totalPaise)}</strong>
        </p>
        <p className="small-text">Prices include GST. {credit ? "This credit note reverses the invoice above." : "Thank you for shopping with us."}</p>
        <footer className="small-text">Computer-generated {credit ? "credit note" : "invoice"}; no signature needed.</footer>
      </article>
    </div>
  );
}
