#include "kernels.h"

#ifndef RK_SOURCE_HASH
#error "build.py passes the sources' hash as RK_SOURCE_HASH"
#endif

extern "C" const char* rk_source_hash() { return RK_SOURCE_HASH; }
