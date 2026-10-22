#!/bin/sh
# Pure helpers for the backup service (sourced by backup.sh and healthcheck.sh, tested by bats).
# POSIX sh + date(1) (GNU coreutils or busybox). Everything is UTC.

# num STR: strip leading zeros so "08" is not read as octal by $(( )).
num() {
  _n="${1#0}"
  _n="${_n#0}"
  printf '%s' "${_n:-0}"
}

# field_match FIELD VALUE MIN MAX: does one cron field (*, n, a-b, */s, a-b/s, lists) match VALUE?
field_match() {
  _f="$1"
  _v="$2"
  _min="$3"
  _max="$4"
  set -f
  for _part in $(printf '%s' "$_f" | tr ',' ' '); do
    _step=1
    _range="$_part"
    case "$_part" in
      */*)
        _range="${_part%%/*}"
        _step="${_part#*/}"
        ;;
    esac
    case "$_range" in
      '*')
        _lo="$_min"
        _hi="$_max"
        ;;
      *-*)
        _lo="${_range%-*}"
        _hi="${_range#*-}"
        ;;
      *)
        _lo="$_range"
        if [ "$_step" -gt 1 ]; then _hi="$_max"; else _hi="$_range"; fi
        ;;
    esac
    if [ "$_v" -ge "$_lo" ] && [ "$_v" -le "$_hi" ] && [ $(((_v - _lo) % _step)) -eq 0 ]; then
      set +f
      return 0
    fi
  done
  set +f
  return 1
}

# field_valid FIELD MIN MAX: syntax and bounds of one cron field.
field_valid() {
  _f="$1"
  _min="$2"
  _max="$3"
  [ -n "$_f" ] || return 1
  set -f
  for _part in $(printf '%s' "$_f" | tr ',' ' '); do
    _range="$_part"
    case "$_part" in
      */*)
        _range="${_part%%/*}"
        _step="${_part#*/}"
        case "$_step" in '' | *[!0-9]*) set +f; return 1 ;; esac
        [ "$_step" -ge 1 ] || { set +f; return 1; }
        ;;
    esac
    case "$_range" in
      '*') ;;
      *-*)
        _a="${_range%-*}"
        _b="${_range#*-}"
        case "$_a$_b" in '' | *[!0-9]*) set +f; return 1 ;; esac
        { [ -n "$_a" ] && [ -n "$_b" ] && [ "$_a" -ge "$_min" ] && [ "$_b" -le "$_max" ] && [ "$_a" -le "$_b" ]; } || { set +f; return 1; }
        ;;
      *)
        case "$_range" in '' | *[!0-9]*) set +f; return 1 ;; esac
        { [ "$_range" -ge "$_min" ] && [ "$_range" -le "$_max" ]; } || { set +f; return 1; }
        ;;
    esac
  done
  set +f
  return 0
}

# cron_valid "M H DOM MON DOW": 0 when it is a well-formed 5-field expression.
cron_valid() {
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  [ "$#" -eq 5 ] || return 1
  field_valid "$1" 0 59 && field_valid "$2" 0 23 && field_valid "$3" 1 31 &&
    field_valid "$4" 1 12 && field_valid "$5" 0 7
}

# dow_match FIELD DOW: day of week 0-6 (Sunday = 0 or 7).
dow_match() {
  field_match "$1" "$2" 0 7 && return 0
  [ "$2" -eq 0 ] && field_match "$1" 7 0 7
}

# cron_next "EXPR" EPOCH: print the first matching minute strictly after EPOCH (epoch seconds).
# Prints nothing and fails when nothing matches within a year.
cron_next() {
  set -f
  # shellcheck disable=SC2086
  set -- $1 "$2"
  set +f
  c_min="$1"
  c_hour="$2"
  c_dom="$3"
  c_mon="$4"
  c_dow="$5"
  c_after="$6"
  c_start=$(((c_after / 60 + 1) * 60))
  c_day=$((c_start / 86400))
  c_last=$((c_day + 366))
  while [ "$c_day" -le "$c_last" ]; do
    c_base=$((c_day * 86400))
    # shellcheck disable=SC2046
    set -- $(date -u -d "@$c_base" '+%m %d %w')
    c_m=$(num "$1")
    c_d=$(num "$2")
    c_w="$3"
    if field_match "$c_mon" "$c_m" 1 12; then
      d_ok=false
      w_ok=false
      field_match "$c_dom" "$c_d" 1 31 && d_ok=true
      dow_match "$c_dow" "$c_w" && w_ok=true
      # Vixie cron: when both day fields are restricted, either one matching is enough.
      day_ok=false
      if [ "$c_dom" != '*' ] && [ "$c_dow" != '*' ]; then
        if $d_ok || $w_ok; then day_ok=true; fi
      elif $d_ok && $w_ok; then
        day_ok=true
      fi
      if $day_ok; then
        c_h=0
        while [ "$c_h" -lt 24 ]; do
          if field_match "$c_hour" "$c_h" 0 23; then
            c_mi=0
            while [ "$c_mi" -lt 60 ]; do
              c_t=$((c_base + c_h * 3600 + c_mi * 60))
              if [ "$c_t" -ge "$c_start" ] && field_match "$c_min" "$c_mi" 0 59; then
                printf '%s\n' "$c_t"
                return 0
              fi
              c_mi=$((c_mi + 1))
            done
          fi
          c_h=$((c_h + 1))
        done
      fi
    fi
    c_day=$((c_day + 1))
  done
  return 1
}

# schedule_interval "EXPR" EPOCH: seconds between the next two runs after EPOCH.
schedule_interval() {
  _a="$(cron_next "$1" "$2")" || return 1
  _b="$(cron_next "$1" "$_a")" || return 1
  printf '%s\n' $((_b - _a))
}

# backup_stamp NAME: "orch-20261022T030000Z.dump.age" -> 20261022T030000Z
backup_stamp() {
  _s="${1#orch-}"
  printf '%s' "${_s%%.*}"
}

# week_key YYYYMMDD: ISO year-week of that day.
week_key() {
  date -u -d "$(printf '%s' "$1" | sed 's/^\(....\)\(..\)\(..\)$/\1-\2-\3/') 00:00:00" '+%G-%V'
}

# rotation_select KEEP_DAILY KEEP_WEEKLY KEEP_MONTHLY < names
# Reads backup file names (orch-<stamp>.dump[.age]) on stdin and prints the ones to DELETE.
# A backup is kept when it is the newest of one of the last KEEP_DAILY days, KEEP_WEEKLY ISO
# weeks or KEEP_MONTHLY months that have at least one backup. Anything else is printed.
# Other file names are ignored (never printed), so stray files are never deleted.
rotation_select() {
  r_kd="$1"
  r_kw="$2"
  r_km="$3"
  r_seen_d=' '
  r_seen_w=' '
  r_seen_m=' '
  r_nd=0
  r_nw=0
  r_nm=0
  sort -r | while IFS= read -r r_name; do
    case "$r_name" in
      orch-*.dump | orch-*.dump.age) ;;
      *) continue ;;
    esac
    r_stamp="$(backup_stamp "$r_name")"
    r_day="${r_stamp%%T*}"
    r_mon="${r_day%??}"
    r_keep=false
    case "$r_seen_d" in
      *" $r_day "*) ;;
      *)
        if [ "$r_nd" -lt "$r_kd" ]; then
          r_keep=true
          r_nd=$((r_nd + 1))
          r_seen_d="$r_seen_d$r_day "
        fi
        ;;
    esac
    r_wk="$(week_key "$r_day")"
    case "$r_seen_w" in
      *" $r_wk "*) ;;
      *)
        if [ "$r_nw" -lt "$r_kw" ]; then
          r_keep=true
          r_nw=$((r_nw + 1))
          r_seen_w="$r_seen_w$r_wk "
        fi
        ;;
    esac
    case "$r_seen_m" in
      *" $r_mon "*) ;;
      *)
        if [ "$r_nm" -lt "$r_km" ]; then
          r_keep=true
          r_nm=$((r_nm + 1))
          r_seen_m="$r_seen_m$r_mon "
        fi
        ;;
    esac
    $r_keep || printf '%s\n' "$r_name"
  done
}
