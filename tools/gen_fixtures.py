#!/usr/bin/env python3
"""Generate golden test fixtures for the TypeScript port of the pgx
bridge_bidding observation encoding and the brl policy network.

The observation functions below are copied VERBATIM from pgx v1.4.0
(pgx/bridge_bidding.py, Apache-2.0) — the exact environment the brl models
were trained in. pgx itself does not import on Python 3.11, so we vendor the
four pure functions we need and run them under real jax.

Usage:
    venv/bin/python tools/gen_fixtures.py packages/ai/models/sl packages/ai/test/fixtures.json
"""
import json
import random
import sys

import jax
import jax.numpy as jnp
import numpy as np

# ---------------------------------------------------------------------------
# Verbatim from pgx v1.4.0 bridge_bidding.py (constants + observation logic)
# ---------------------------------------------------------------------------
PASS_ACTION_NUM = 0
DOUBLE_ACTION_NUM = 1
REDOUBLE_ACTION_NUM = 2
BID_OFFSET_NUM = 3


def _player_position(player, state):
    return jax.lax.cond(
        player != -1,
        lambda: jnp.int8(jnp.argmax(state._shuffled_players == player)),
        lambda: jnp.int8(-1),
    )


def _observe(state, player_id):
    """Returns the observation of a given player"""
    # make vul of observation
    is_player_vul, is_non_player_vul = jax.lax.cond(
        (_player_position(state.current_player, state) == 0)
        | (_player_position(state.current_player, state) == 2),
        lambda: (state._vul_NS, state._vul_EW),
        lambda: (state._vul_EW, state._vul_NS),
    )
    vul = jnp.array(
        [~is_player_vul, is_player_vul, ~is_non_player_vul, is_non_player_vul],
        dtype=jnp.bool_,
    )

    # make hand of observation
    hand = jnp.zeros(52, dtype=jnp.bool_)
    position = _player_position(player_id, state).astype(jnp.int16)
    hand = jax.lax.fori_loop(
        position * 13,
        (position + 1) * 13,
        lambda i, hand: hand.at[
            _convert_card_pgx_to_openspiel(state._hand[i])
        ].set(True),
        hand,
    )

    # make history of observation
    last_bid = 0
    obs_history = jnp.zeros(424, dtype=jnp.bool_)
    state, player_id, last_bid, obs_history = jax.lax.fori_loop(
        0,
        state._turn.astype(jnp.int32),
        _make_obs_history,
        (state, player_id, last_bid, obs_history),
    )
    return jnp.concatenate((vul, obs_history, hand))


def _make_obs_history(turn, vuls):
    state, player_id, last_bid, obs_history = vuls
    action = state._bidding_history[turn]
    relative_bidder = (
        (turn + state._dealer.astype(jnp.int32)) % 4
        + (4 - _player_position(player_id, state).astype(jnp.int32))
    ) % 4
    last_bid, obs_history = jax.lax.cond(
        action <= 2,
        lambda: jax.lax.switch(
            action,
            [
                lambda: jax.lax.cond(
                    last_bid == 0,
                    lambda: (
                        last_bid,
                        obs_history.at[relative_bidder].set(True),
                    ),
                    lambda: (last_bid, obs_history),
                ),
                lambda: (
                    last_bid,
                    obs_history.at[
                        4
                        + (last_bid - BID_OFFSET_NUM) * 4 * 3
                        + 4
                        + relative_bidder
                    ].set(True),
                ),
                lambda: (
                    last_bid,
                    obs_history.at[
                        4
                        + (last_bid - BID_OFFSET_NUM) * 4 * 3
                        + 4 * 2
                        + relative_bidder
                    ].set(True),
                ),
            ],
        ),
        lambda: (
            action,
            obs_history.at[
                4 + (action - BID_OFFSET_NUM) * 4 * 3 + relative_bidder
            ].set(True),
        ),
    )
    return state, player_id, last_bid, obs_history


def _convert_card_pgx_to_openspiel(card):
    """Convert numerical representation of cards from pgx to openspiel"""
    OPEN_SPIEL_SUIT_NUM = jnp.array([3, 2, 1, 0], dtype=jnp.int32)
    OPEN_SPIEL_RANK_NUM = jnp.array(
        [12, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], dtype=jnp.int32
    )
    suit = OPEN_SPIEL_SUIT_NUM[card // 13]
    rank = OPEN_SPIEL_RANK_NUM[card % 13]
    return suit + rank * 4


# ---------------------------------------------------------------------------
# Fixture generation
# ---------------------------------------------------------------------------

@jax.tree_util.register_pytree_node_class
class State:
    """Pytree stand-in exposing the State fields _observe reads."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

    def tree_flatten(self):
        keys = sorted(self.__dict__)
        return [self.__dict__[k] for k in keys], keys

    @classmethod
    def tree_unflatten(cls, keys, values):
        return cls(**dict(zip(keys, values)))


def ours_to_pgx_card(card):
    """Our encoding: suit*13+rank, suits S,H,D,C, rank 0='2'..12='A'.
    pgx encoding: same suit order, rank 0='A', 1='2'..12='K'."""
    suit, rank = divmod(card, 13)
    return suit * 13 + (0 if rank == 12 else rank + 1)


def random_auction(rng, max_len):
    """Random legal auction prefix (not ended). Returns list of actions."""
    calls = []
    last_bid = None
    last_bidder_rel = None  # parity of caller index relative to dealer
    doubled = False
    redoubled = False
    pass_run = 0
    for i in range(max_len):
        legal = [PASS_ACTION_NUM]
        start = BID_OFFSET_NUM if last_bid is None else last_bid + 1
        legal += list(range(start, 38))
        if last_bid is not None:
            opp = (i - last_bidder_rel) % 2 == 1
            if not doubled and not redoubled and opp:
                legal.append(DOUBLE_ACTION_NUM)
            if doubled and not redoubled and not opp:
                legal.append(REDOUBLE_ACTION_NUM)
        # bias towards low bids and passes so auctions look realistic
        weights = [8.0 if a == PASS_ACTION_NUM else 2.0 if a in (1, 2) else max(0.1, 3.0 - 0.15 * (a - 3)) for a in legal]
        action = rng.choices(legal, weights)[0]
        # avoid ending the auction (we only observe mid-auction states)
        if action == PASS_ACTION_NUM:
            if last_bid is None and pass_run == 3:
                continue
            if last_bid is not None and pass_run == 2:
                continue
            pass_run += 1
        else:
            pass_run = 0
            if action == DOUBLE_ACTION_NUM:
                doubled = True
            elif action == REDOUBLE_ACTION_NUM:
                redoubled = True
            else:
                last_bid = action
                last_bidder_rel = i
                doubled = redoubled = False
        calls.append(action)
    return calls


def forward(manifest_dir, obs):
    with open(manifest_dir + ".json") as f:
        manifest = json.load(f)
    data = np.fromfile(manifest_dir + ".bin", dtype="<f4")
    x = obs.astype(np.float32)
    layers = manifest["layers"]
    for layer in layers[:4]:
        w = data[layer["w"]["offset"]:layer["w"]["offset"] + layer["w"]["size"]].reshape(layer["w"]["shape"])
        b = data[layer["b"]["offset"]:layer["b"]["offset"] + layer["b"]["size"]]
        x = np.maximum(x @ w + b, 0.0)
    actor = layers[4]
    w = data[actor["w"]["offset"]:actor["w"]["offset"] + actor["w"]["size"]].reshape(actor["w"]["shape"])
    b = data[actor["b"]["offset"]:actor["b"]["offset"] + actor["b"]["size"]]
    return x @ w + b


def main():
    model_path, out_path = sys.argv[1], sys.argv[2]
    rng = random.Random(20260712)
    fixtures = []
    for case in range(24):
        cards = list(range(52))
        rng.shuffle(cards)
        hands = [sorted(cards[s * 13:(s + 1) * 13]) for s in range(4)]
        dealer = rng.randrange(4)
        vul_ns = rng.random() < 0.5
        vul_ew = rng.random() < 0.5
        calls = random_auction(rng, rng.randrange(0, 12))
        actor = (dealer + len(calls)) % 4

        pgx_hand = np.zeros(52, dtype=np.int32)
        for seat in range(4):
            for i, c in enumerate(hands[seat]):
                pgx_hand[seat * 13 + i] = ours_to_pgx_card(c)
        history = np.zeros(319, dtype=np.int32)
        history[:len(calls)] = calls
        state = State(
            _shuffled_players=jnp.arange(4, dtype=jnp.int8),
            current_player=jnp.int8(actor),
            _hand=jnp.array(pgx_hand),
            _dealer=jnp.int8(dealer),
            _vul_NS=jnp.bool_(vul_ns),
            _vul_EW=jnp.bool_(vul_ew),
            _turn=jnp.int32(len(calls)),
            _bidding_history=jnp.array(history),
        )
        obs = np.asarray(_observe(state, jnp.int8(actor))).astype(np.int8)
        assert obs.shape == (480,), obs.shape
        logits = forward(model_path, obs)
        fixtures.append({
            "hands": hands,
            "dealer": dealer,
            "vulNS": vul_ns,
            "vulEW": vul_ew,
            "actorSeat": actor,
            "calls": calls,
            "observation": obs.tolist(),
            "logits": [float(v) for v in logits],
        })

    with open(out_path, "w") as f:
        json.dump(fixtures, f)
    print(f"wrote {len(fixtures)} fixtures to {out_path}")


if __name__ == "__main__":
    main()
