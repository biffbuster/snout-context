"""The office's command line: python -m berthbook [--data DIR] <command> <month>."""
import argparse

from .billing import invoices_for_month
from .fuel import sale_cents, sales_for_month
from .report import format_money, format_table
from .store import Store


def main(argv=None):
    parser = argparse.ArgumentParser(prog="berthbook")
    parser.add_argument("--data", default="data", help="the folder with vessels.json, bookings.json and fuel.json")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, text in [("bookings", "the month's bookings"), ("invoices", "the month's invoices"), ("fuel", "the month's fuel dock sales")]:
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
    return 0
