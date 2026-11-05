"""Files for finance's spreadsheet, which runs with a German locale: semicolons, a decimal comma."""
import csv


def finance_amount(cents):
    """Cents as finance's spreadsheet reads money: 123480 -> "1234,80" (no thousands separator)."""
    sign = "-" if cents < 0 else ""
    whole, part = divmod(abs(cents), 100)
    return f"{sign}{whole},{part:02d}"


def write_csv(out, header, rows):
    writer = csv.writer(out, delimiter=";", lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
