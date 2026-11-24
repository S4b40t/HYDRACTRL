// SPDX-License-Identifier: AGPL-3.0-only

#include <ableton/Link.hpp>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <stdexcept>
#include <string>

#ifndef _WIN32
#include <csignal>
#endif

namespace
{
double parseQuantum(const char* text)
{
  const std::string argument{text};
  std::size_t end = 0;
  const auto quantum = std::stod(argument, &end);
  if (end != argument.size() || !std::isfinite(quantum) || quantum < 0.001 || quantum > 64)
  {
    throw std::invalid_argument("quantum must be a number between 0.001 and 64");
  }
  // The SDK represents beats in millionths. Use the same quantum in the protocol.
  return std::round(quantum * 1e6) / 1e6;
}

void probe(const double quantum)
{
  // Outlives Link and its callback thread.
  std::atomic<std::uint32_t> tempoRevision{0};
  ableton::Link link(120.0);
  link.setTempoCallback([&tempoRevision](double) {
    tempoRevision.fetch_add(1, std::memory_order_relaxed);
  });
  link.enableStartStopSync(false);
  link.enable(true);

  std::string command;
  while (std::getline(std::cin, command))
  {
    if (!command.empty() && command.back() == '\r') command.pop_back();
    if (command == "quit") break;
    if (command != "sample") throw std::runtime_error("expected sample or quit");

    const auto state = link.captureAppSessionState();
    const auto hostTime = link.clock().micros();
    std::cout << "{\"version\":1,\"hostUs\":" << hostTime.count()
              << ",\"bpm\":" << state.tempo()
              << ",\"beat\":" << state.beatAtTime(hostTime, quantum)
              << ",\"phase\":" << state.phaseAtTime(hostTime, quantum)
              << ",\"quantum\":" << quantum
              << ",\"peers\":" << link.numPeers()
              << ",\"enabled\":" << (link.isEnabled() ? "true" : "false")
              << ",\"tempoRevision\":" << tempoRevision.load(std::memory_order_relaxed)
              << "}\n" << std::flush;
    // The owner may have closed its pipes without waiting for the reply.
    if (!std::cout) break;
  }
  link.enable(false);
}
} // namespace

int main(int argc, char** argv)
{
#ifndef _WIN32
  std::signal(SIGPIPE, SIG_IGN);
#endif
  std::cout.imbue(std::locale::classic());
  std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
  try
  {
    if (argc > 2) throw std::invalid_argument("usage: hydractrl-link [quantum]");
    probe(argc == 2 ? parseQuantum(argv[1]) : 4.0);
    return 0;
  }
  catch (const std::exception& error)
  {
    std::cerr << "hydractrl-link: " << error.what() << '\n';
    return 1;
  }
}
