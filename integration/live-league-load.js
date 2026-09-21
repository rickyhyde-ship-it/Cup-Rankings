// Replaces the old snapshot lookup block in loadLiveLeague.
          state.liveCompetition = competition;
          const freshClubs = [];
          for (const club of clubs) {
            if (runId !== state.liveLoadRun || controller.signal.aborted) return;
            setLiveStatus(`Fetching current squads: ${freshClubs.length + 1} / ${clubs.length} clubs…`, 'loading');
            freshClubs.push(await fetchClubLiveStrength(club, controller.signal));
          }
          if (runId !== state.liveLoadRun || controller.signal.aborted) return;
          state.liveClubs = freshClubs;
          state.liveFetchedAt = new Date().toISOString();
          renderLiveResults();
          const rankedCount = freshClubs.filter(club => club.playerCount >= 11).length;
          setLiveStatus(`Loaded ${formatNumber(rankedCount)} eligible clubs using fresh MFL squad ratings. Updated ${new Date(state.liveFetchedAt).toLocaleTimeString()}.`, 'success');
