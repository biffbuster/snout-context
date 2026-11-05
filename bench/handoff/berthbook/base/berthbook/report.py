"""Text output for the office: tables and money as the office writes it."""


def format_money(cents):
    """Cents as the office writes money: 123450 -> "1,234.50"."""
    sign = "-" if cents < 0 else ""
    whole, part = divmod(abs(cents), 100)
    return f"{sign}{whole:,}.{part:02d}"


def format_table(headers, rows):
    """Rows of strings as a fixed-width table, numbers right-aligned."""
    cells = [list(map(str, headers))] + [[str(c) for c in r] for r in rows]
    widths = [max(len(r[i]) for r in cells) for i in range(len(headers))]

    def line(r):
        out = []
        for i, c in enumerate(r):
            numeric = c.replace(",", "").replace(".", "").replace("-", "").isdigit()
            out.append(c.rjust(widths[i]) if numeric else c.ljust(widths[i]))
        return "  ".join(out).rstrip()

    return "\n".join([line(cells[0]), "  ".join("-" * w for w in widths)] + [line(r) for r in cells[1:]])
