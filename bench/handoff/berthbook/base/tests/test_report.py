from berthbook.report import format_money, format_table


def test_money_as_the_office_writes_it():
    assert format_money(123450) == "1,234.50"
    assert format_money(5) == "0.05"
    assert format_money(-2500) == "-25.00"


def test_table_aligns_numbers_right():
    out = format_table(["Vessel", "Amount"], [["Marlin", "1,234.80"], ["Osprey", "136.50"]])
    assert out.splitlines()[2] == "Marlin  1,234.80"
    assert out.splitlines()[3] == "Osprey    136.50"
