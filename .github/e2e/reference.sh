#!/bin/bash
# CI reference renders: runs the client game test (src/gametest) under a virtual display while reference.mjs takes
# the viewer's picture. Stops early when the game cannot open a window, and never waits longer than 25 minutes.
set -u
run=build/run/clientGameTest
screen="${REFERENCE_SCREEN:--screen 0 1280x720x24}"

echo "::group::virtual display and graphics drivers"
xvfb-run -a -s "$screen" glxinfo -B 2>&1 | head -n 30 || true
xvfb-run -a -s "$screen" bash -c 'glxinfo 2>/dev/null | grep -cE "^0x[0-9a-f]+ 32 " | sed "s/^/32-bit visuals: /"' || true
xvfb-run -a -s "$screen" vulkaninfo --summary 2>&1 | grep -E "deviceName|driverName|apiVersion|VK_KHR_(xlib|xcb)_surface|ERROR" | head -n 20 || true
echo "::endgroup::"

(cd .github/e2e && exec timeout 1500 node reference.mjs "../../$run/reference") > reference-viewer.log 2>&1 &
viewer=$!

xvfb-run -a -s "$screen" ./gradlew runClientGameTest --no-daemon --no-configuration-cache > game.log 2>&1 &
game=$!

status=0
for second in $(seq 1 1500); do
	if ! kill -0 $game 2>/dev/null; then
		wait $game
		status=$?
		break
	fi
	# both graphics backends failed: the game stays open without a window, so stop it
	if grep -q "Failed to create backend OpenGL" game.log && grep -q "Failed to create backend Vulkan" game.log; then
		echo "the game could not create a graphics backend (OpenGL or Vulkan)"
		status=1
		break
	fi
	sleep 1
done
kill $game $viewer 2>/dev/null
pkill -f runClientGameTest 2>/dev/null
pkill -f KnotClient 2>/dev/null

echo "::group::game log"
grep -vE "^\s+at |^\s*$" game.log | tail -n 150
echo "::endgroup::"
echo "::group::viewer log"
cat reference-viewer.log
echo "::endgroup::"
exit $status
