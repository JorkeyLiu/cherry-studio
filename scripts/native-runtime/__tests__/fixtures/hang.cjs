'use strict'
// Test-owned hanging child: never emits the probe marker and never exits on
// its own. Lets the bounded diagnostic timeout terminate it.
setInterval(() => {}, 1000)
