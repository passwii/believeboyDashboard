import Foundation
import XCTest

@testable import BelieveBoyKit

/// SSE：帧解析（纯逻辑）+ 流式消费 / 取消 / 错误分类。
final class SSEStreamTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    // MARK: - 帧解析

    /// 只有空行才成帧 —— 这是 SSE 最容易被想当然的地方（「有 data 就有事件」是错的）。
    func testFrameDispatchesOnBlankLineOnly() {
        var parser = SSEFrameParser()

        // 换行只结束「行」，并不成帧：还需要一个额外的空行。
        XCTAssertTrue(parser.feed(Data("data: {\"a\":1}\n".utf8)).isEmpty, "行尾换行不成帧")
        XCTAssertEqual(
            parser.feed(Data("\n".utf8)),
            [ServerSentEvent(data: "{\"a\":1}")],
            "空行才 dispatch"
        )
        XCTAssertTrue(parser.feed(Data("\n".utf8)).isEmpty, "没有待派发数据时，空行不产生事件")

        // 只剩内容、没有换行 → 缓冲区里还不成行，流结束时补发。
        XCTAssertTrue(parser.feed(Data("data: {\"b\":2}".utf8)).isEmpty)
        XCTAssertEqual(parser.finish(), [ServerSentEvent(data: "{\"b\":2}")])
    }

    func testMultiLineDataIsJoinedWithNewline() {
        var parser = SSEFrameParser()
        let events = parser.feed(Data("data: line1\ndata: line2\n\n".utf8))
        XCTAssertEqual(events, [ServerSentEvent(data: "line1\nline2")])
    }

    func testIDEventNameAndRetryAreParsed() {
        var parser = SSEFrameParser()
        let events = parser.feed(Data("id: 42\nevent: delta\nretry: 1500\ndata: {}\n\n".utf8))

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.id, "42")
        XCTAssertEqual(events.first?.event, "delta")
        XCTAssertEqual(events.first?.retry, 1500)
        XCTAssertEqual(parser.lastEventID, "42", "续传游标要能被取到")
    }

    /// 注释（`: keep-alive`）不产生事件、也不污染 data。
    func testCommentLinesAndHeartbeatsAreIgnored() {
        var parser = SSEFrameParser()
        XCTAssertTrue(parser.feed(Data(": keep-alive\n\n".utf8)).isEmpty)

        let events = parser.feed(Data(": ping\ndata: x\n\n".utf8))
        XCTAssertEqual(events, [ServerSentEvent(data: "x")])
    }

    /// `\r\n` 行尾（部分代理会改写）与「值前只去一个空格」。
    func testCRLFLineEndingsAndSingleLeadingSpaceRule() {
        var parser = SSEFrameParser()
        let events = parser.feed(Data("data:  two spaces\r\n\r\n".utf8))
        XCTAssertEqual(events, [ServerSentEvent(data: " two spaces")])
    }

    /// `data:` 值为空 → 数据为空 → 不成帧（规范要求）。
    func testEmptyDataFrameIsNotDispatched() {
        var parser = SSEFrameParser()
        XCTAssertTrue(parser.feed(Data("data:\n\n".utf8)).isEmpty)
        XCTAssertTrue(parser.feed(Data("id: 9\n\n".utf8)).isEmpty, "只有 id 没有 data 也不成帧")
        XCTAssertEqual(parser.lastEventID, "9", "id 仍要更新，否则重连会从头重放")
    }

    /// 帧被切成任意字节边界（网络分片从不按行对齐）时结果必须一致。
    func testFramesAreIdenticalWhenFedByteByByte() {
        let payload = Data("id: 1\ndata: {\"a\":1}\n\ndata: 二\n\n: c\n\n".utf8)
        var whole = SSEFrameParser()
        let allAtOnce = whole.feed(payload)

        var bytewise = SSEFrameParser()
        var collected: [ServerSentEvent] = []
        for byte in payload {
            collected.append(contentsOf: bytewise.feed(Data([byte])))
        }

        XCTAssertEqual(collected, allAtOnce)
        XCTAssertEqual(allAtOnce, [
            ServerSentEvent(id: "1", data: "{\"a\":1}"),
            ServerSentEvent(data: "二"),
        ])
    }

    func testFinishFlushesTrailingFrameWithoutBlankLine() {
        var parser = SSEFrameParser()
        XCTAssertTrue(parser.feed(Data("data: last".utf8)).isEmpty)
        XCTAssertEqual(parser.finish(), [ServerSentEvent(data: "last")])
    }

    func testEventPayloadDecodesSnakeCaseJSON() throws {
        let event = ServerSentEvent(data: #"{"run_id":"r-1","event_type":"delta"}"#)
        struct Payload: Decodable, Sendable, Equatable {
            let runId: String
            let eventType: String
        }

        let payload = try event.decode(Payload.self)
        XCTAssertEqual(payload, Payload(runId: "r-1", eventType: "delta"))
    }

    // MARK: - 流式消费

    func testStreamSendsSSEAcceptAndUnboundedTimeout() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/insight/runs/r-1/stream": .stream(chunks: ["data: {}\n\n"]),
        ])
        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)

        var received: [ServerSentEvent] = []
        for try await event in client.stream("/insight/runs/r-1/stream", lastEventID: "cursor-7") {
            received.append(event)
        }

        XCTAssertEqual(received.count, 1)
        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.method, "GET")
        XCTAssertEqual(recorded.path, "/api/v1/insight/runs/r-1/stream")
        XCTAssertEqual(recorded.header("Accept"), "text/event-stream")
        XCTAssertEqual(recorded.header("Last-Event-ID"), "cursor-7", "断线续传游标")
        XCTAssertEqual(recorded.apiKey, "blf_test")
        XCTAssertEqual(
            recorded.timeout,
            RequestTier.unboundedTimeout,
            ".stream 档必须摆脱 Foundation 默认的 60s（SSE 数据间隙可以很长）"
        )
    }

    /// 逐块消费：第一帧在第二帧到达之前就已经交到调用方手里（不是「等流结束一次性给你」）。
    func testFramesAreDeliveredIncrementallyAsTheyArrive() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/insight/runs/r-1/stream": .stream(
                chunks: ["data: {\"n\":1}\n\n", "data: {\"n\":2}\n\n"],
                holdsOpen: true,
                chunkDelay: 0.3
            ),
        ])
        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)

        let received = LockedBox<[ServerSentEvent]>([])
        let sawFirst = expectation(description: "第一帧")
        let consumer = Task {
            for try await event in client.stream("/insight/runs/r-1/stream") {
                received.mutate { $0.append(event) }
                if received.value.count == 1 { sawFirst.fulfill() }
            }
        }
        defer { consumer.cancel() }

        await fulfillment(of: [sawFirst], timeout: 5)
        XCTAssertEqual(
            received.value.count,
            1,
            "第一帧到手时第二帧还不该到（否则就是攒完再给，不是流式）"
        )
    }

    /// 取消必须**收拾干净**：连接被拆掉（`stopLoading`），消费方退出，不留下后台 Task。
    func testCancellingConsumerTearsDownTheConnectionAndLeavesNoTask() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/insight/runs/r-1/stream": .stream(
                chunks: ["data: {\"n\":1}\n\n"],
                holdsOpen: true
            ),
        ])
        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)

        let sawFirst = expectation(description: "第一帧")
        let consumerFinished = expectation(description: "消费方退出")
        let consumer = Task {
            do {
                for try await _ in client.stream("/insight/runs/r-1/stream") {
                    sawFirst.fulfill()
                }
            } catch {
                // 取消不是错误，吞掉即可。
            }
            consumerFinished.fulfill()
        }

        await fulfillment(of: [sawFirst], timeout: 5)
        consumer.cancel()
        await fulfillment(of: [consumerFinished], timeout: 5)

        let tornDown = await waitUntil { StubURLProtocol.stopLoadingCount > 0 }
        XCTAssertTrue(tornDown, "取消后 URLSession 任务必须被拆掉（stopLoading 已调用）")
        XCTAssertEqual(StubURLProtocol.stoppedPaths, ["/api/v1/insight/runs/r-1/stream"])
    }

    /// 403（key 被 Web 端登录顶掉的主路径）必须以凭据问题呈现。
    func testAuthFailureSurfacesAsCredentialProblem() async {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/insight/runs/r-1/stream": .json(403, #"{"detail":"Invalid API key"}"#),
        ])
        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)

        do {
            for try await _ in client.stream("/insight/runs/r-1/stream") {
                XCTFail("403 不该产出事件")
            }
            XCTFail("403 必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized(status: 403, body: #"{"detail":"Invalid API key"}"#))
            XCTAssertTrue(error.requiresCredentialFix)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }

    func testTransportFailureSurfacesAsTransportNotCredential() async {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/insight/runs/r-1/stream": StubURLProtocol.Response(
                status: 0,
                body: "",
                failure: URLError(.networkConnectionLost)
            ),
        ])
        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)

        do {
            for try await _ in client.stream("/insight/runs/r-1/stream") {}
            XCTFail("连接中断必须抛错")
        } catch let error as APIError {
            guard case .transport = error else {
                return XCTFail("期望 .transport，实际 \(error)")
            }
            XCTAssertFalse(error.requiresCredentialFix)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }

    func testMissingCredentialFailsWithoutOpeningConnection() async {
        let session = StubURLProtocol.session(routes: [:])
        let client = APIClient(baseURL: baseURL, apiKey: nil, session: session)

        do {
            for try await _ in client.stream("/insight/runs/r-1/stream") {}
            XCTFail("缺凭据必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .missingCredential)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
        XCTAssertTrue(StubURLProtocol.log.isEmpty)
    }

    // MARK: - 工具

    private func waitUntil(
        timeout: TimeInterval = 3,
        _ condition: @Sendable () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }
}
