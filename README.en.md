# Stats Table Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/)

A Home Assistant Lovelace card that renders **tabular reports** (hourly, daily, weekly or monthly) from HA **long-term statistics**. It works for water, steam, heat, electricity and any other sensor with statistics.

**[Русская версия](README.md)** (full documentation). The card UI labels are in Russian, but every table caption is configurable.

![Daily report with highlighting](docs/screenshot-day.png)

## Why

Report tables built from SQL queries and markdown cards are slow (tens of seconds per week of data), lose data after `purge_keep_days`, and need an automation plus helper entities for every table.

This card reads pre-aggregated statistics through the websocket API (`recorder/statistics_during_period`):

- a month or a year renders in a fraction of a second;
- long-term statistics are kept forever;
- no SQL, automations or template sensors are needed.

## Features

- Rows per `hour` / `day` / `week` / `month`; any statistic type: `mean`, `min`, `max`, `change`, `state`, `sum`.
- Build values from finer statistics (`source_period: hour | 5minute`) with `agg: sum | avg | avg_nonzero | min | max | first | last | count`.
- Column formulas (`c1 / 60`), multipliers, grouped two-level headers.
- Multiple footer rows and summary rows from extra sensors.
- Threshold highlighting (`below` / `above` / `equals` / `empty`, levels warn / bad / good, row markers, legend).
- Built-in period picker: date inputs, ◀ ▶ shifting, presets, remembered selection, `?from=&to=` URL parameters.
- Live "today" row from 5-minute statistics, auto refresh.
- `prefer`: an exact source (e.g. an energy meter) for completed intervals, with a fallback calculation for the rest.
- CSV export (Excel friendly), print styles, theme aware, single file without dependencies.

## Installation

**HACS:** add `https://github.com/Lordhmen/stats-table-card` as a custom repository of type *Dashboard*, then install **Stats Table Card**.

**Manual:** copy `stats-table-card.js` to `/config/www/`, then add a resource `/local/stats-table-card.js?v=1.0.0` of type *JavaScript module*.

## Minimal example

```yaml
type: custom:stats-table-card
title: Water
period: day
columns:
  - entity: sensor.water_meter_total
    name: Volume
    unit: m³
    stat: change
```

The sensor must have a `state_class`:

- `measurement` sensors provide `mean` / `min` / `max`;
- `total` and `total_increasing` sensors provide `change` / `sum` / `state`.

## Main options

Card: `columns`, `period`, `title`, `subtitle` (`{range}` placeholder), `date_header`, `date_format` (`DD.MM`), `decimal_separator`, `empty`, `font_size`, `column_borders`, `footers`, `footer_title`, `footer_labels`, `summary`, `live_today`, `refresh_interval`, `csv`, `show_debug`, `prefer_since`, `time_zone`.

Period picker: `controls`, `default_range`, `presets` (`today`, `yesterday`, `3d`, `7d`, `30d`, `month`, `prev_month`, `year`), `storage_key`, `url_params`, legacy `start_entity` / `end_entity`.

Column: `entity` or `formula`, `name`, `unit`, `group`, `stat`, `decimals`, `multiplier`, `source_period`, `agg`, `fallback_stat`, `prefer`, `footer`, `footer_decimals`, `footer_label`, `dim`, `highlight`.

See [README.md](README.md) for the full option reference and [`examples/`](examples/) for ready-made configurations.

## License

[MIT](LICENSE)
