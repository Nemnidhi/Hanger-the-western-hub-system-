import type { SizeChart } from "@/lib/types";

export function SizeChartTable({ chart, highlight = "" }: { chart: SizeChart; highlight?: string }) {
  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>
        {chart.name} · {chart.unit}
      </p>
      <div className="table-scroll">
        <table className="chart">
          <thead>
            <tr>
              {chart.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.rows.map((row) => (
              <tr key={row[0]} className={row[0] === highlight ? "mine" : ""}>
                {row.map((cell, index) => (
                  <td key={index}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {chart.note && <p className="small muted">{chart.note}</p>}
    </div>
  );
}
