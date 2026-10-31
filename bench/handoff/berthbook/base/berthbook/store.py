"""Reads the records from a data folder: vessels.json, bookings.json and fuel.json."""
import json
from pathlib import Path

from .models import Booking, FuelSale, Vessel


class Store:
    def __init__(self, folder):
        self.folder = Path(folder)

    def _read(self, name):
        path = self.folder / name
        if not path.exists():
            return []
        return json.loads(path.read_text(encoding="utf-8"))

    def vessels(self):
        """Every vessel, by id."""
        return {v["id"]: Vessel(**v) for v in self._read("vessels.json")}

    def bookings(self):
        return [Booking(**b) for b in self._read("bookings.json")]

    def fuel_sales(self):
        return [FuelSale(**f) for f in self._read("fuel.json")]
