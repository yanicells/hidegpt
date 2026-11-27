#!/usr/bin/env python3
"""Per-process resource counters for the perf bench (macOS only).

Reads one line of space-separated pids from stdin and writes one JSON line:
{pid: {instructions, cycles, cpu_ms, footprint_mb}}. Instructions retired is the
bench's main CPU measure because, unlike CPU time, it does not change when other
work shares the machine or when the scheduler moves a thread to an efficiency core.
"""
import ctypes
import json
import sys

FIELDS = (
    "ri_user_time ri_system_time ri_pkg_idle_wkups ri_interrupt_wkups ri_pageins ri_wired_size "
    "ri_resident_size ri_phys_footprint ri_proc_start_abstime ri_proc_exit_abstime ri_child_user_time "
    "ri_child_system_time ri_child_pkg_idle_wkups ri_child_interrupt_wkups ri_child_pageins "
    "ri_child_elapsed_abstime ri_diskio_bytesread ri_diskio_byteswritten ri_cpu_time_qos_default "
    "ri_cpu_time_qos_maintenance ri_cpu_time_qos_background ri_cpu_time_qos_utility ri_cpu_time_qos_legacy "
    "ri_cpu_time_qos_user_initiated ri_cpu_time_qos_user_interactive ri_billed_system_time "
    "ri_serviced_system_time ri_logical_writes ri_lifetime_max_phys_footprint ri_instructions ri_cycles "
    "ri_billed_energy ri_serviced_energy ri_interval_max_phys_footprint ri_runnable_time"
).split()


class RUsageInfoV4(ctypes.Structure):
    _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in FIELDS]


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
libc = ctypes.CDLL("/usr/lib/libSystem.dylib")
timebase = Timebase()
libc.mach_timebase_info(ctypes.byref(timebase))
TICK_NS = timebase.numer / timebase.denom


def read(pid):
    info = RUsageInfoV4()
    if libproc.proc_pid_rusage(int(pid), 4, ctypes.byref(info)) != 0:
        return None
    return {
        "instructions": info.ri_instructions,
        "cycles": info.ri_cycles,
        "cpu_ms": (info.ri_user_time + info.ri_system_time) * TICK_NS / 1e6,
        "footprint_mb": info.ri_phys_footprint / 1048576,
    }


for line in sys.stdin:
    print(json.dumps({pid: read(pid) for pid in line.split()}), flush=True)
