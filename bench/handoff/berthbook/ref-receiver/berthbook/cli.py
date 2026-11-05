"""The office's command line: python -m berthbook [--data DIR] <command> <month>."""
import argparse
import sys

from .billing import invoices_for_month
from .finance import finance_amount, write_csv
from .fuel import sale_cents, sales_for_month
from .report import format_money, format_table
from .store import Store


def main(argv=None):
    parser = argparse.ArgumentParser(prog="berthbook")
    parser.add_argument("--data", default="data", help="the folder with vessels.json, bookings.json and fuel.json")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, text in [("bookings", "the month's bookings"), ("invoices", "the month's invoices"), ("fuel", "the month's fuel dock sales"),
                       ("export-invoices", "the month's invoices as CSV for finance"), ("export-fuel", "the month's fuel sales per vessel as CSV for finance")]:
        p = sub.add_parser(name, help=text)
        p.add_argument("month", help="YYYY-MM")
    args = parser.parse_args(argv)
    store = Store(args.data)

    if args.command == "bookings":
        vessels = store.vessels()
        rows = [[b.berth, vessels[b.vessel_id].name, b.start, b.end] for b in store.bookings() if b.start.startswith(args.month)]
        print(format_table(["Berth", "Vessel", "From", "To"], rows))
    elif args.command == "invoices":
        rows = [[i.number, i.vessel, f"{i.hours:g}", format_money(i.amount_cents)] for i in invoices_for_month(store, args.month)]
        print(format_table(["Invoice", "Vessel", "Hours", "Amount"], rows))
    elif args.command == "fuel":
        vessels = store.vessels()
        rows = [[s.date, vessels[s.vessel_id].name, f"{s.litres:g}", format_money(sale_cents(s))] for s in sales_for_month(store, args.month)]
        print(format_table(["Date", "Vessel", "Litres", "Amount"], rows))
    elif args.command == "export-invoices":
        rows = [[i.number, i.vessel, finance_amount(i.amount_cents)] for i in invoices_for_month(store, args.month)]
        write_csv(sys.stdout, ["invoice", "vessel", "amount"], rows)
    elif args.command == "export-fuel":
        vessels = store.vessels()
        totals = {}
        for s in sales_for_month(store, args.month):
            litres, cents = totals.get(vessels[s.vessel_id].name, (0.0, 0))
            totals[vessels[s.vessel_id].name] = (litres + s.litres, cents + sale_cents(s))
        rows = [[name, f"{litres:g}".replace(".", ","), finance_amount(cents)] for name, (litres, cents) in sorted(totals.items())]
        write_csv(sys.stdout, ["vessel", "litres", "amount"], rows)
    return 0
